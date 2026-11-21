"""3D progress model: 2D structural drawings -> building spec -> 3D elements, coloured by progress from the database.

Plan: plan/3d-progress-model-plan.md. Modules:
    spec.py       building spec format, the Riverside reference spec, validation
    generator.py  spec -> 3D boxes (slabs, walls, columns...) assigned to pours (pure, no DB)
    progress.py   pour states from observations/events, planned and forecast states, timeline, "why" (pure + DB loader)
    prompts.py    P5 "Building spec" extraction from the drawings (LLM, cited)
    store.py      database reads/writes (models, pours, elements, element_progress)
    routes.py     HTTP routes under /projects/{project_id}/models
    schema.py     idempotent DDL behind migration 0010_model3d
    seed_demo.py  demo structure reports for A300/A310, written through the normal tables
"""
