const assert = require("node:assert/strict");
const test = require("node:test");
const Database = require("better-sqlite3");

const { applyJarvisMigrations, TARGET_VERSION } = require("../../src/jarvis/main/JarvisMigrations");

function insertTodo(db, id, at = 1) {
  db.prepare(
    `INSERT INTO todos_v2 (
       id, canonical_base_key, instance_key, title, status, provenance,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'open', 'evidence_linked', ?, ?)`
  ).run(id, "a".repeat(64), `${id.charCodeAt(id.length - 1)}`.repeat(64).slice(0, 64), id, at, at);
}

function applicationSnapshot(segmentId = "segment-1") {
  return [
    {
      segmentId,
      applicationKey: null,
      sourceAttribution: "microphone",
      speakerRelation: "SELF",
    },
  ];
}

function activitySnapshot(segmentId = "segment-1") {
  return [
    {
      segmentId,
      category: "work_meeting",
      confidence: 0.92,
      decision: "adopted",
    },
  ];
}

function insertCapturedAutomaticDecision(
  db,
  {
    id,
    todoInstanceId,
    occurredAt,
    applications = applicationSnapshot(),
    activities = activitySnapshot(),
  }
) {
  return db
    .prepare(
      `INSERT INTO todo_verification_decisions (
         id, todo_instance_id, state, reason, actor, occurred_at,
         trust_policy_id, trust_snapshot_state, application_snapshot_json,
         activity_snapshot_json, semantic_confidence_snapshot,
         voiceprint_confidence_snapshot, scene_confidence_snapshot,
         transcript_context_confidence_snapshot,
         speaker_evidence_verified_snapshot, overlap_detected_snapshot,
         automatic_eligible
       ) VALUES (
         ?, ?, 'confirmed', 'strict_self_commitment', 'system', ?,
         'todo-attribution-v1', 'captured', ?, ?, 0.9, 0.91, 0.92, 0.8,
         1, 0, 1
       )`
    )
    .run(id, todoInstanceId, occurredAt, JSON.stringify(applications), JSON.stringify(activities));
}

test("v53 stores immutable trust snapshots and gates system auto-confirmation in SQLite", () => {
  const db = new Database(":memory:");
  try {
    applyJarvisMigrations(db, { now: () => 1_000 });
    assert.ok(TARGET_VERSION >= 53);
    insertTodo(db, "todo-1");

    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO todo_verification_decisions (
               id, todo_instance_id, state, reason, actor, occurred_at
             ) VALUES (?, ?, 'confirmed', 'strict_self_commitment', 'system', ?)`
          )
          .run("decision-invalid", "todo-1", 2),
      /strict todo trust snapshot/u
    );

    insertCapturedAutomaticDecision(db, {
      id: "decision-valid",
      todoInstanceId: "todo-1",
      occurredAt: 3,
    });

    assert.deepEqual(
      db
        .prepare(
          `SELECT effective_state, trust_snapshot_state, automatic_eligible
           FROM todo_effective_verification WHERE todo_instance_id = ?`
        )
        .get("todo-1"),
      { effective_state: "confirmed", trust_snapshot_state: "captured", automatic_eligible: 1 }
    );
    assert.throws(
      () =>
        db
          .prepare(
            `UPDATE todo_verification_decisions
             SET semantic_confidence_snapshot = 1 WHERE id = ?`
          )
          .run("decision-valid"),
      /immutable/u
    );
  } finally {
    db.close();
  }
});

test("v53 rejects malformed or inconsistent captured trust snapshots", () => {
  const db = new Database(":memory:");
  try {
    applyJarvisMigrations(db, { now: () => 1_000 });
    insertTodo(db, "todo-shape");

    const validApplication = applicationSnapshot()[0];
    const validActivity = activitySnapshot()[0];
    const rejected = [
      {
        id: "decision-null-item",
        applications: [null],
        activities: activitySnapshot(),
      },
      {
        id: "decision-missing-field",
        applications: [
          {
            segmentId: "segment-1",
            applicationKey: null,
            sourceAttribution: "microphone",
          },
        ],
        activities: activitySnapshot(),
      },
      {
        id: "decision-extra-field",
        applications: [{ ...validApplication, unexpected: true }],
        activities: activitySnapshot(),
      },
      {
        id: "decision-duplicate-segment",
        applications: [{ ...validApplication }, { ...validApplication }],
        activities: [{ ...validActivity }, { ...validActivity }],
      },
      {
        id: "decision-segment-set-mismatch",
        applications: applicationSnapshot("segment-1"),
        activities: activitySnapshot("segment-2"),
      },
    ];

    for (const fixture of rejected) {
      assert.throws(
        () =>
          insertCapturedAutomaticDecision(db, {
            ...fixture,
            todoInstanceId: "todo-shape",
            occurredAt: 2,
          }),
        /snapshot shape is invalid/u,
        fixture.id
      );
    }
  } finally {
    db.close();
  }
});

test("v51 treats legacy system confirmations conservatively but preserves user authority", () => {
  const db = new Database(":memory:");
  try {
    applyJarvisMigrations(db, { now: () => 1_000 });
    db.exec(`
      DROP VIEW todo_effective_verification;
      DROP TRIGGER todo_verification_decisions_strict_insert;
      DROP TRIGGER todo_verification_decisions_trust_immutable_update;
    `);
    insertTodo(db, "todo-2", 2);
    insertTodo(db, "todo-3", 3);
    db.exec(`
      INSERT INTO todo_verification_decisions (
        id, todo_instance_id, state, reason, actor, occurred_at
      ) VALUES
        ('legacy-system', 'todo-2', 'confirmed', 'strict_self_commitment', 'system', 4),
        ('legacy-user', 'todo-3', 'confirmed', 'user_confirmed', 'user', 5);
      PRAGMA user_version = 50;
    `);

    assert.deepEqual(applyJarvisMigrations(db, { now: () => 2_000 }), {
      fromVersion: 50,
      toVersion: TARGET_VERSION,
    });
    assert.deepEqual(
      db
        .prepare(
          `SELECT todo_instance_id, effective_state, trust_snapshot_state
           FROM todo_effective_verification ORDER BY todo_instance_id`
        )
        .all(),
      [
        {
          todo_instance_id: "todo-2",
          effective_state: "pending_confirmation",
          trust_snapshot_state: "legacy_unverified",
        },
        {
          todo_instance_id: "todo-3",
          effective_state: "confirmed",
          trust_snapshot_state: "legacy_unverified",
        },
      ]
    );
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});

test("v53 downgrades v52 captured confirmations without speaker and overlap flags", () => {
  const db = new Database(":memory:");
  try {
    applyJarvisMigrations(db, { now: () => 1_000 });
    db.exec(`
      DROP VIEW todo_effective_verification;
      DROP TRIGGER todo_verification_decisions_snapshot_shape_insert;
      DROP TRIGGER todo_verification_decisions_strict_insert;
      DROP TRIGGER todo_verification_decisions_trust_immutable_update;
    `);
    insertTodo(db, "todo-v52", 2);
    db.prepare(
      `INSERT INTO todo_verification_decisions (
         id, todo_instance_id, state, reason, actor, occurred_at,
         trust_policy_id, trust_snapshot_state, application_snapshot_json,
         activity_snapshot_json, semantic_confidence_snapshot,
         voiceprint_confidence_snapshot, scene_confidence_snapshot,
         transcript_context_confidence_snapshot, automatic_eligible
       ) VALUES (
         ?, ?, 'confirmed', 'strict_self_commitment', 'system', ?,
         'todo-attribution-v1', 'captured', ?, ?, 0.9, 0.91, 0.92, 0.8, 1
       )`
    ).run(
      "decision-v52",
      "todo-v52",
      3,
      JSON.stringify(applicationSnapshot()),
      JSON.stringify(activitySnapshot())
    );
    db.pragma("user_version = 52");

    assert.deepEqual(applyJarvisMigrations(db, { now: () => 2_000 }), {
      fromVersion: 52,
      toVersion: TARGET_VERSION,
    });
    assert.deepEqual(
      db
        .prepare(
          `SELECT decision.state, effective.effective_state,
                  decision.trust_policy_id, decision.trust_snapshot_state,
                  decision.application_snapshot_json, decision.activity_snapshot_json,
                  decision.semantic_confidence_snapshot,
                  decision.voiceprint_confidence_snapshot,
                  decision.scene_confidence_snapshot,
                  decision.transcript_context_confidence_snapshot,
                  decision.speaker_evidence_verified_snapshot,
                  decision.overlap_detected_snapshot,
                  decision.automatic_eligible
           FROM todo_verification_decisions AS decision
           JOIN todo_effective_verification AS effective ON effective.id = decision.id
           WHERE decision.id = ?`
        )
        .get("decision-v52"),
      {
        state: "confirmed",
        effective_state: "pending_confirmation",
        trust_policy_id: "legacy-unverified-v1",
        trust_snapshot_state: "legacy_unverified",
        application_snapshot_json: "[]",
        activity_snapshot_json: "[]",
        semantic_confidence_snapshot: null,
        voiceprint_confidence_snapshot: null,
        scene_confidence_snapshot: null,
        transcript_context_confidence_snapshot: null,
        speaker_evidence_verified_snapshot: null,
        overlap_detected_snapshot: null,
        automatic_eligible: 0,
      }
    );
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});
