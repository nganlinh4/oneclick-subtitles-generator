use super::*;

const LIMITS: TreeLimits = TreeLimits {
    policy: PathPolicy::PACKAGE,
    max_files: 16,
};

#[test]
fn portable_paths_reject_traversal_devices_and_platform_syntax() {
    for policy in [PathPolicy::TOOL, PathPolicy::PACKAGE] {
        for invalid in [
            "",
            "../model",
            "model/../x",
            "/root",
            "C:/model",
            "model\\x",
            "model//x",
            "model/",
            "model/./x",
            "model/CON",
            "model/com1.bin",
            "model/COM0",
            "model/lpt9.txt",
            "model/aux",
            "model/trailing.",
            "model/caf\u{e9}",
        ] {
            assert!(
                validate_relative_path(invalid, policy).is_err(),
                "{invalid}"
            );
        }
        assert!(validate_relative_path("model/weights/model-00001.safetensors", policy).is_ok());
        assert!(validate_relative_path("licenses/tool-LICENSE.txt", policy).is_ok());
    }
}

#[test]
fn package_punctuation_and_depth_are_policy_specific() {
    let package_name = "runtime/Lib/site-packages/setuptools/script (dev).tmpl";
    assert!(validate_relative_path(package_name, PathPolicy::PACKAGE).is_ok());
    assert!(validate_relative_path(package_name, PathPolicy::TOOL).is_err());
    assert!(validate_relative_path("bin/name@1", PathPolicy::TOOL).is_err());

    let seventeen = vec!["d"; 17].join("/");
    assert!(validate_relative_path(&seventeen, PathPolicy::TOOL).is_err());
    assert!(validate_relative_path(&seventeen, PathPolicy::PACKAGE).is_ok());
    let twenty_five = vec!["d"; 25].join("/");
    assert!(validate_relative_path(&twenty_five, PathPolicy::PACKAGE).is_err());
}

#[test]
fn prepare_target_creates_parents_and_refuses_files_in_the_way() {
    let temp = tempfile::tempdir().unwrap();
    let target = prepare_target(temp.path(), "bin/tool.exe", PathPolicy::TOOL).unwrap();
    assert!(temp.path().join("bin").is_dir());
    assert_eq!(target, temp.path().join("bin/tool.exe"));

    fs::write(temp.path().join("licenses"), b"not a directory").unwrap();
    assert_eq!(
        prepare_target(temp.path(), "licenses/NOTICE.txt", PathPolicy::TOOL),
        Err(DeliveryError::UnsafeArchive)
    );
}

#[test]
fn known_tree_removal_preserves_unexpected_files_and_deletes_the_marker_last() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("tree");
    fs::create_dir_all(root.join("bin")).unwrap();
    fs::write(root.join("bin/tool.exe"), b"tool").unwrap();
    fs::write(root.join("receipt.json"), b"{}").unwrap();
    let allowed = HashSet::from(["bin/tool.exe".to_owned(), "receipt.json".to_owned()]);

    fs::write(root.join("user.txt"), b"keep").unwrap();
    assert_eq!(
        remove_known_tree(&root, &allowed, Some("receipt.json"), LIMITS),
        Err(DeliveryError::InvalidInstall)
    );
    assert_eq!(fs::read(root.join("user.txt")).unwrap(), b"keep");

    fs::remove_file(root.join("user.txt")).unwrap();
    remove_known_tree(&root, &allowed, Some("receipt.json"), LIMITS).unwrap();
    assert!(!root.exists());
}

#[test]
fn a_non_empty_tree_without_its_ownership_marker_is_not_deleted() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("tree");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("tool.exe"), b"tool").unwrap();
    let allowed = HashSet::from(["tool.exe".to_owned(), "receipt.json".to_owned()]);
    assert_eq!(
        remove_known_tree(&root, &allowed, Some("receipt.json"), LIMITS),
        Err(DeliveryError::InvalidInstall)
    );
    assert!(root.join("tool.exe").exists());
    remove_known_tree(&root, &allowed, None, LIMITS).unwrap();
    assert!(!root.exists());
}

#[test]
fn walks_are_bounded_by_file_and_directory_counts() {
    let temp = tempfile::tempdir().unwrap();
    let limits = TreeLimits {
        policy: PathPolicy::TOOL,
        max_files: 2,
    };
    for name in ["a", "b", "c"] {
        fs::write(temp.path().join(name), b"x").unwrap();
    }
    assert_eq!(collect_regular_files(temp.path(), limits).unwrap().len(), 3);
    fs::write(temp.path().join("d"), b"x").unwrap();
    assert!(collect_regular_files(temp.path(), limits).is_err());

    let nested = tempfile::tempdir().unwrap();
    fs::create_dir_all(nested.path().join("one/two")).unwrap();
    assert!(collect_regular_files(nested.path(), limits).is_err());
}

#[cfg(windows)]
#[test]
fn junctions_are_refused_by_walks_and_target_preparation() {
    let temp = tempfile::tempdir().unwrap();
    let outside = temp.path().join("outside");
    let root = temp.path().join("root");
    fs::create_dir_all(&outside).unwrap();
    fs::create_dir_all(&root).unwrap();
    fs::write(outside.join("secret.txt"), b"outside").unwrap();
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(root.join("bin"))
        .arg(&outside)
        .status()
        .unwrap();
    assert!(status.success());

    assert!(collect_regular_files(&root, LIMITS).is_err());
    assert_eq!(
        prepare_target(&root, "bin/tool.exe", PathPolicy::TOOL),
        Err(DeliveryError::UnsafeArchive)
    );
    assert_eq!(
        resolve_owned(&root, "bin/secret.txt", PathPolicy::TOOL),
        Err(DeliveryError::InvalidInstall)
    );
    let allowed = HashSet::from(["bin/secret.txt".to_owned()]);
    assert!(remove_known_tree(&root, &allowed, None, LIMITS).is_err());
    assert_eq!(fs::read(outside.join("secret.txt")).unwrap(), b"outside");
    fs::remove_dir(root.join("bin")).unwrap();
}
