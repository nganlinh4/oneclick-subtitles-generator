use super::run_loop::credential_slot;

#[test]
fn parallel_windows_rotate_across_ready_credentials() {
    assert_eq!(
        (0..4)
            .map(|index| credential_slot(index, 20))
            .collect::<Vec<_>>(),
        [0, 1, 2, 3]
    );
    assert_eq!(
        (0..6)
            .map(|index| credential_slot(index, 2))
            .collect::<Vec<_>>(),
        [0, 1, 0, 1, 0, 1]
    );
}
