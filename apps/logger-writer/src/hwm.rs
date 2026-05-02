//! Per-partition Kafka high-water-mark tracking.
//!
//! Stored on the Iceberg snapshot summary as flat `kafka_offset_p<n>` keys.
//! On startup we scan recent snapshots and resolve the max offset per
//! partition independently — that handles both single-replica writers
//! (where every commit carries every partition) and any future multi-replica
//! shape where each replica commits only its assigned partitions.

use std::collections::HashMap;

const KEY_PREFIX: &str = "kafka_offset_p";

/// Build the snapshot-property map from the in-memory HWM map. Empty
/// returns an empty HashMap so callers can pass it through unconditionally.
pub fn to_snapshot_properties(hwm: &HashMap<i32, i64>) -> HashMap<String, String> {
    hwm.iter()
        .map(|(p, off)| (format!("{KEY_PREFIX}{p}"), off.to_string()))
        .collect()
}

/// Walk a sequence of snapshot summary maps (newest-first) and resolve the
/// max offset per partition. Properties on different snapshots may cover
/// disjoint partitions; we keep the largest seen for each.
pub fn resolve_from_snapshots<'a, I>(snapshots: I) -> HashMap<i32, i64>
where
    I: IntoIterator<Item = &'a HashMap<String, String>>,
{
    let mut out: HashMap<i32, i64> = HashMap::new();
    for summary in snapshots {
        for (k, v) in summary {
            let Some(rest) = k.strip_prefix(KEY_PREFIX) else { continue };
            let Ok(partition) = rest.parse::<i32>() else { continue };
            let Ok(offset) = v.parse::<i64>() else { continue };
            out.entry(partition)
                .and_modify(|current| {
                    if offset > *current {
                        *current = offset;
                    }
                })
                .or_insert(offset);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_single_partition() {
        let mut hwm = HashMap::new();
        hwm.insert(0, 12345i64);
        let props = to_snapshot_properties(&hwm);
        assert_eq!(props.get("kafka_offset_p0").map(String::as_str), Some("12345"));

        let resolved = resolve_from_snapshots([&props]);
        assert_eq!(resolved.get(&0), Some(&12345i64));
    }

    #[test]
    fn merge_takes_max_per_partition_across_snapshots() {
        let mut a = HashMap::new();
        a.insert("kafka_offset_p0".into(), "100".into());
        a.insert("kafka_offset_p1".into(), "50".into());

        let mut b = HashMap::new();
        b.insert("kafka_offset_p0".into(), "200".into());
        b.insert("kafka_offset_p2".into(), "10".into());

        // Newer (a) listed first, but b carries higher p0 from earlier;
        // the max should still win.
        let resolved = resolve_from_snapshots([&a, &b]);
        assert_eq!(resolved.get(&0), Some(&200i64));
        assert_eq!(resolved.get(&1), Some(&50i64));
        assert_eq!(resolved.get(&2), Some(&10i64));
    }

    #[test]
    fn ignores_unrelated_keys_and_bad_values() {
        let mut s = HashMap::new();
        s.insert("kafka_offset_p0".into(), "42".into());
        s.insert("added-files".into(), "5".into()); // standard Iceberg key
        s.insert("kafka_offset_p_bad".into(), "1".into()); // not a number after prefix
        s.insert("kafka_offset_p3".into(), "not-a-number".into());

        let resolved = resolve_from_snapshots([&s]);
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved.get(&0), Some(&42i64));
    }
}
