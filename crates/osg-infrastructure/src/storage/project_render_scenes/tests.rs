use osg_domain::ProjectMetadata;
use tempfile::TempDir;

use super::*;
use crate::storage::Database;

fn project(database: &Database, name: &str) -> ProjectId {
    let metadata = ProjectMetadata::with_id(ProjectId::new(), name).expect("metadata");
    database
        .create_project(&metadata)
        .expect("create project")
        .metadata()
        .id()
}

#[test]
fn scenes_are_project_owned_independent_cas_and_survive_reopen() {
    let directory = TempDir::new().expect("directory");
    let path = directory.path().join("osg.sqlite3");
    let database = Database::open(&path).expect("database");
    let project_a = project(&database, "A");
    let project_b = project(&database, "B");
    let write = |project_id, expected_scene_revision, marker: &str| ProjectRenderSceneWrite {
        project_id,
        expected_scene_revision,
        schema_version: PROJECT_RENDER_SCENE_SCHEMA_VERSION,
        scene_json: format!(r#"{{"marker":"{marker}"}}"#),
    };
    let a1 = database
        .put_project_render_scene(&write(project_a, 0, "a1"))
        .expect("first A scene");
    let b1 = database
        .put_project_render_scene(&write(project_b, 0, "b1"))
        .expect("first B scene");
    let a2 = database
        .put_project_render_scene(&write(project_a, 1, "a2"))
        .expect("second A scene");
    assert_eq!(
        (a1.scene_revision, b1.scene_revision, a2.scene_revision),
        (1, 1, 2)
    );
    assert!(matches!(
        database.put_project_render_scene(&write(project_a, 1, "stale")),
        Err(DatabaseError::StaleProjectRenderScene { actual: 2, .. })
    ));
    drop(database);

    let reopened = Database::open(path).expect("reopen");
    assert_eq!(
        reopened
            .get_project_render_scene(project_a)
            .expect("read A")
            .expect("A scene"),
        a2
    );
    assert_eq!(
        reopened
            .get_project_render_scene(project_b)
            .expect("read B")
            .expect("B scene"),
        b1
    );
}

#[test]
fn missing_projects_and_malformed_or_oversized_json_are_refused() {
    let directory = TempDir::new().expect("directory");
    let database = Database::open(directory.path().join("osg.sqlite3")).expect("database");
    let missing = ProjectId::new();
    let base = ProjectRenderSceneWrite {
        project_id: missing,
        expected_scene_revision: 0,
        schema_version: PROJECT_RENDER_SCENE_SCHEMA_VERSION,
        scene_json: "{}".to_owned(),
    };
    assert!(matches!(
        database.put_project_render_scene(&base),
        Err(DatabaseError::ProjectNotFound(id)) if id == missing
    ));
    let owner = project(&database, "Owner");
    for scene_json in ["[]".to_owned(), "{".to_owned(), "x".repeat(65_537)] {
        assert!(matches!(
            database.put_project_render_scene(&ProjectRenderSceneWrite {
                project_id: owner,
                scene_json,
                ..base.clone()
            }),
            Err(DatabaseError::InvalidProjectRenderScene)
        ));
    }
}
