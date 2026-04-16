/// Compute the hierarchical bucket ID for a set of PK column hashes.
///
/// Each PK column is hashed independently. The hashes are combined into a
/// single physical bucket ID: `level_0 * sub_count_1 + level_1 * sub_count_2 + ...`
///
/// Power-of-2 alignment at each level enables shuffle-less cross-table joins
/// on shared PK prefixes.
pub fn hierarchical_bucket_id(pk_hashes: &[u64], bucket_levels: &[u32]) -> u32 {
    assert_eq!(
        pk_hashes.len(),
        bucket_levels.len(),
        "pk_hashes and bucket_levels must have the same length"
    );

    let mut physical_bucket: u32 = 0;
    let mut multiplier: u32 = 1;

    // Build from the last level to the first (least significant to most significant)
    for i in (0..pk_hashes.len()).rev() {
        let level_bucket = (pk_hashes[i] % bucket_levels[i] as u64) as u32;
        physical_bucket += level_bucket * multiplier;
        multiplier *= bucket_levels[i];
    }

    physical_bucket
}

/// Compute the hash of a PK value using xxhash64.
pub fn hash_pk_value(value: Option<&[u8]>) -> u64 {
    match value {
        Some(bytes) => xxhash_rust::xxh64::xxh64(bytes, 0),
        None => 0, // NULL always hashes to 0
    }
}

/// Map a fine-grained bucket ID to a coarser bucket ID at a specific level.
///
/// Used when stitching loads with different bucket counts at a given level.
/// `fine_bucket % coarse_count` gives the aligned coarse bucket.
pub fn align_bucket(fine_bucket: u32, fine_count: u32, coarse_count: u32) -> u32 {
    if fine_count == coarse_count {
        fine_bucket
    } else {
        fine_bucket % coarse_count
    }
}

/// Compute the total bucket count from hierarchical levels.
pub fn total_buckets(bucket_levels: &[u32]) -> u32 {
    bucket_levels.iter().product()
}

/// Validate that all bucket levels are powers of 2.
pub fn validate_bucket_levels(levels: &[u32]) -> bool {
    levels.iter().all(|&l| l > 0 && l.is_power_of_two())
}

/// Compute the next power of 2 >= n. Returns 1 for n <= 1.
pub fn next_power_of_two(n: u64) -> u32 {
    if n <= 1 {
        return 1;
    }
    let p = n.next_power_of_two();
    p.min(4096) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_single_level_bucket() {
        let hashes = [42u64];
        let levels = [32u32];
        assert_eq!(hierarchical_bucket_id(&hashes, &levels), 42 % 32);
    }

    #[test]
    fn test_two_level_bucket() {
        // level_1 = xxhash(user_id) % 32 = 10
        // level_2 = xxhash(game_id) % 4 = 2
        // physical = 10 * 4 + 2 = 42
        let hashes = [10u64, 2u64]; // pre-modded for clarity
        let levels = [32u32, 4u32];
        // hashes[0] % 32 = 10, hashes[1] % 4 = 2 → 10*4 + 2 = 42
        assert_eq!(hierarchical_bucket_id(&hashes, &levels), 42);
    }

    #[test]
    fn test_bucket_alignment() {
        // Fine bucket 42 in 128-bucket space → coarse bucket in 32-bucket space
        assert_eq!(align_bucket(42, 128, 32), 42 % 32); // = 10
        assert_eq!(align_bucket(10, 32, 32), 10);
    }

    #[test]
    fn test_null_hash() {
        assert_eq!(hash_pk_value(None), 0);
    }

    #[test]
    fn test_validate_levels() {
        assert!(validate_bucket_levels(&[1, 2, 4, 8, 16, 32]));
        assert!(!validate_bucket_levels(&[3]));
        assert!(!validate_bucket_levels(&[0]));
    }

    #[test]
    fn test_next_power_of_two() {
        assert_eq!(next_power_of_two(0), 1);
        assert_eq!(next_power_of_two(1), 1);
        assert_eq!(next_power_of_two(3), 4);
        assert_eq!(next_power_of_two(128), 128);
        assert_eq!(next_power_of_two(129), 256);
        assert_eq!(next_power_of_two(100000), 4096); // clamped
    }
}
