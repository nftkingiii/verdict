//! Verdict: a Telegraph comparator module (ABI per
//! https://anjoman.ai/docs/scoring/build-a-scoring-module, "Comparator modules").
//!
//! The node reads the value out of the miner answer, scales it to fixed point and
//! hands this module two integers plus a 16-byte spec. The module therefore only
//! implements the network's reference rule, exactly. It is generic: it has no
//! knowledge of any intent, node, market, price or contributor.
//!
//! Exports:
//!   imw_score_deterministic(truth: i64, miner: i64, spec_ptr: i32) -> i64
//!   imw_alloc(size: i32) -> i32
//!   imw_free(ptr: i32, size: i32)
//!
//! Spec (16 bytes at spec_ptr, little endian): code: i64, tolerance: i64.
//! Return: score in basis points 0..=10000, or -1 when the input is refused.
#![no_std]

pub const CODE_EXACT: i32 = 0;
pub const CODE_ABS_TOL: i32 = 1;
pub const CODE_REL_TOL: i32 = 2;
pub const CODE_PASS_FAIL: i32 = 3;

const FULL: i128 = 10_000;

/// Pure reference rule. Never panics, never overflows (all arithmetic in i128).
pub fn score(truth: i64, miner: i64, code: i32, tolerance: i64) -> i64 {
    let exact = if miner == truth { FULL } else { 0 };
    let (err, tol): (i128, i128) = match code {
        CODE_ABS_TOL => ((miner as i128 - truth as i128).abs(), tolerance as i128),
        CODE_REL_TOL => {
            let diff = (miner as i128 - truth as i128).abs();
            let denom = (truth as i128).abs().max(1);
            (diff * FULL / denom, tolerance as i128)
        }
        // Exact, PassFail and any unknown code: exact match only.
        _ => return exact as i64,
    };
    if tol <= 0 {
        return exact as i64;
    }
    let window = 2 * tol;
    if err >= window {
        return 0;
    }
    (FULL * (window - err) / window) as i64
}

// ---- tiny bump arena for the 16-byte spec the node writes -------------------

const ARENA_SIZE: usize = 64 * 1024;

#[repr(align(16))]
#[allow(dead_code)]
struct Arena([u8; ARENA_SIZE]);

static mut ARENA: Arena = Arena([0; ARENA_SIZE]);
static mut USED: usize = 0;
static mut LIVE: usize = 0;

/// Returns a pointer to `size` writable bytes, or 0 if it cannot be served.
#[no_mangle]
pub extern "C" fn imw_alloc(size: i32) -> i32 {
    if size <= 0 {
        return 0;
    }
    let size = ((size as usize) + 15) & !15;
    unsafe {
        if USED + size > ARENA_SIZE {
            return 0;
        }
        let base = core::ptr::addr_of_mut!(ARENA) as *mut u8;
        let p = base.add(USED);
        USED += size;
        LIVE += 1;
        p as usize as i32
    }
}

/// Releases memory; the arena rewinds once every allocation has been freed.
#[no_mangle]
pub extern "C" fn imw_free(_ptr: i32, _size: i32) {
    unsafe {
        if LIVE > 0 {
            LIVE -= 1;
            if LIVE == 0 {
                USED = 0;
            }
        }
    }
}

#[cfg(target_arch = "wasm32")]
fn mem_bytes() -> usize {
    core::arch::wasm32::memory_size(0) * 65_536
}
#[cfg(not(target_arch = "wasm32"))]
fn mem_bytes() -> usize {
    usize::MAX
}

#[no_mangle]
pub extern "C" fn imw_score_deterministic(truth: i64, miner: i64, spec_ptr: i32) -> i64 {
    if spec_ptr <= 0 {
        return -1;
    }
    let p = spec_ptr as u32 as usize;
    match p.checked_add(16) {
        Some(end) if end <= mem_bytes() => {}
        _ => return -1,
    }
    let (code64, tol) = unsafe {
        let b = p as *const u8;
        let mut c = [0u8; 8];
        let mut t = [0u8; 8];
        for i in 0..8 {
            c[i] = core::ptr::read_unaligned(b.add(i));
            t[i] = core::ptr::read_unaligned(b.add(8 + i));
        }
        (i64::from_le_bytes(c), i64::from_le_bytes(t))
    };
    // "The code is read as a 32-bit integer."
    score(truth, miner, code64 as i32, tol)
}

#[cfg(all(not(test), target_arch = "wasm32"))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

#[cfg(test)]
extern crate std;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_and_passfail_ignore_tolerance() {
        for code in [CODE_EXACT, CODE_PASS_FAIL, 99, -1] {
            assert_eq!(score(100, 100, code, 5), 10_000);
            assert_eq!(score(100, 101, code, 1_000_000), 0);
        }
    }

    #[test]
    fn abs_tol_linear_window() {
        assert_eq!(score(1000, 1000, CODE_ABS_TOL, 10), 10_000);
        assert_eq!(score(1000, 1010, CODE_ABS_TOL, 10), 5_000);
        assert_eq!(score(1000, 990, CODE_ABS_TOL, 10), 5_000);
        assert_eq!(score(1000, 1019, CODE_ABS_TOL, 10), 500);
        assert_eq!(score(1000, 1020, CODE_ABS_TOL, 10), 0);
        assert_eq!(score(1000, 5000, CODE_ABS_TOL, 10), 0);
    }

    #[test]
    fn rel_tol_in_basis_points() {
        assert_eq!(score(10_000, 10_100, CODE_REL_TOL, 100), 5_000);
        assert_eq!(score(10_000, 9_900, CODE_REL_TOL, 100), 5_000);
        assert_eq!(score(10_000, 10_200, CODE_REL_TOL, 100), 0);
        assert_eq!(score(-10_000, -10_100, CODE_REL_TOL, 100), 5_000);
        // error in bps truncates toward zero: |4-3|*10000/3 = 3333
        assert_eq!(score(3, 4, CODE_REL_TOL, 10_000), 10_000 * (20_000 - 3_333) / 20_000);
    }

    #[test]
    fn nonpositive_tolerance_means_exact_only() {
        for code in [CODE_ABS_TOL, CODE_REL_TOL] {
            assert_eq!(score(50, 50, code, 0), 10_000);
            assert_eq!(score(50, 51, code, 0), 0);
            assert_eq!(score(50, 51, code, -7), 0);
        }
    }

    #[test]
    fn wei_scale_and_extremes_do_not_overflow() {
        let t = 1_000_000_000_000_000_000i64;
        assert_eq!(score(t, t + t / 100, CODE_REL_TOL, 100), 5_000);
        let s = score(i64::MIN, i64::MAX, CODE_ABS_TOL, i64::MAX);
        assert!((0..=10_000).contains(&s));
        let s = score(i64::MAX, i64::MIN, CODE_REL_TOL, i64::MAX);
        assert!((0..=10_000).contains(&s));
    }

    #[test]
    fn output_always_in_range() {
        for code in [0, 1, 2, 3, 7] {
            for tol in [-5i64, 0, 1, 7, 10_000, i64::MAX] {
                for (t, m) in [(1i64, 1i64), (1, 2), (-5, 5), (i64::MAX, 0), (i64::MIN, i64::MAX)] {
                    let s = score(t, m, code, tol);
                    assert!((0..=10_000).contains(&s), "{code} {tol} {t} {m} -> {s}");
                }
            }
        }
    }

    #[test]
    fn abi_rejects_bad_spec_pointer() {
        assert_eq!(imw_score_deterministic(1, 1, 0), -1);
        assert_eq!(imw_score_deterministic(1, 1, -4), -1);
    }
}
