//! Legacy default subtitle-scale migrations and their late repair after v15.

use super::*;

fn legacy_default_subtitle_scene() -> serde_json::Value {
    json!({
        "customization": {
            "fontSize": 28,
            "fontFamily": "'Google Sans', sans-serif",
            "fontWeight": 400,
            "textColor": "#ffffff",
            "textAlign": "center",
            "lineHeight": 1.2,
            "letterSpacing": 0,
            "backgroundColor": "#000000",
            "backgroundOpacity": 70,
            "backgroundPaddingX": 16,
            "backgroundPaddingY": 8,
            "borderWidth": 0,
            "textShadowEnabled": true,
            "glowEnabled": false,
            "gradientEnabled": false,
            "strokeEnabled": false,
            "multiShadowEnabled": false,
            "pulseEnabled": false,
            "shakeEnabled": false,
            "position": "bottom",
            "marginBottom": 80,
            "marginTop": 80,
            "marginLeft": 0,
            "marginRight": 0,
            "maxWidth": 80,
            "fadeInDuration": 0.3,
            "fadeOutDuration": 0.3,
            "animationType": "fade",
            "wordWrap": true,
            "maxLines": 3,
            "preset": "default"
        }
    })
}

#[test]
fn legacy_default_subtitle_scale_migrates_once_without_overwriting_custom_styles() {
    let mut connection = Connection::open_in_memory().expect("open database");
    migrations()
        .to_version(&mut connection, 12)
        .expect("prepare v12 database");
    let legacy_default = legacy_default_subtitle_scene();
    let customized = {
        let mut value = legacy_default.clone();
        value["customization"]["textColor"] = json!("#ff00ff");
        value
    };
    let current_default = {
        let mut value = legacy_default.clone();
        value["customization"]["fontSize"] = json!(48);
        value
    };
    let intentional_48 = {
        let mut value = current_default.clone();
        value["customization"]["textColor"] = json!("#ff00ff");
        value
    };
    let sparse_legacy_default = {
        let mut value = legacy_default.clone();
        value["customization"]
            .as_object_mut()
            .expect("customization object")
            .remove("backgroundPaddingX");
        value["customization"]
            .as_object_mut()
            .expect("customization object")
            .remove("backgroundPaddingY");
        value
    };

    let fixtures = [
        legacy_default,
        customized,
        current_default,
        sparse_legacy_default,
        intentional_48,
    ];
    let project_ids = [
        Uuid::now_v7(),
        Uuid::now_v7(),
        Uuid::now_v7(),
        Uuid::now_v7(),
        Uuid::now_v7(),
    ];
    for (index, (project_id, scene)) in project_ids.iter().zip(fixtures).enumerate() {
        connection
            .execute(
                "INSERT INTO projects(id, title, state_version, created_at_ms, updated_at_ms)
                     VALUES (?1, ?2, 0, 1, 1)",
                params![project_id, format!("project {index}")],
            )
            .expect("seed project");
        connection
            .execute(
                "INSERT INTO project_render_scenes(
                        project_id, scene_revision, schema_version, scene_json, updated_at_ms
                     ) VALUES (?1, 1, 1, ?2, 1)",
                params![project_id, scene.to_string()],
            )
            .expect("seed scene");
    }

    migrations()
        .to_latest(&mut connection)
        .expect("upgrade v12 database");

    {
        let read_scene = |project_id: Uuid| -> (i64, i64) {
            connection
                .query_row(
                    "SELECT scene_revision,
                                json_extract(scene_json, '$.customization.fontSize')
                         FROM project_render_scenes WHERE project_id = ?1",
                    [project_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("read migrated scene")
        };
        assert_eq!(read_scene(project_ids[0]), (3, 72));
        assert_eq!(read_scene(project_ids[1]), (1, 28));
        assert_eq!(read_scene(project_ids[2]), (2, 72));
        assert_eq!(read_scene(project_ids[3]), (3, 72));
        assert_eq!(read_scene(project_ids[4]), (1, 48));
    }

    migrations()
        .to_latest(&mut connection)
        .expect("repeat latest migration");
    let revision: i64 = connection
        .query_row(
            "SELECT scene_revision FROM project_render_scenes WHERE project_id = ?1",
            [project_ids[0]],
            |row| row.get(0),
        )
        .expect("read scene after repeated migration");
    assert_eq!(revision, 3);
}

#[test]
fn late_legacy_default_subtitle_scale_is_repaired_after_v15() {
    let mut connection = Connection::open_in_memory().expect("open database");
    migrations()
        .to_version(&mut connection, 15)
        .expect("prepare v15 database");
    let exact_id = Uuid::now_v7();
    let custom_id = Uuid::now_v7();
    let exact = legacy_default_subtitle_scene();
    let custom = {
        let mut value = exact.clone();
        value["customization"]["borderRadius"] = json!(12);
        value
    };
    for (id, title, scene) in [(exact_id, "exact", exact), (custom_id, "custom", custom)] {
        connection
            .execute(
                "INSERT INTO projects(id, title, state_version, created_at_ms, updated_at_ms)
                     VALUES (?1, ?2, 0, 1, 1)",
                params![id, title],
            )
            .expect("seed project");
        connection
            .execute(
                "INSERT INTO project_render_scenes(
                        project_id, scene_revision, schema_version, scene_json, updated_at_ms
                     ) VALUES (?1, 1, 1, ?2, 1)",
                params![id, scene.to_string()],
            )
            .expect("seed late scene");
    }

    migrations()
        .to_latest(&mut connection)
        .expect("apply latest");
    let read = |id| {
        connection
            .query_row(
                "SELECT scene_revision, json_extract(scene_json, '$.customization.fontSize')
                     FROM project_render_scenes WHERE project_id = ?1",
                [id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .expect("read scene")
    };
    assert_eq!(read(exact_id), (3, 72));
    assert_eq!(read(custom_id), (1, 28));
}
