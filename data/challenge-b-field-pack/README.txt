Challenge B | Site manager field pack

Start your app with munich-demo/index.json. Resolve each record's path relative to munich-demo/. Load 01-schedule/baseline.json alongside the records. The project, organizations, dictation transcripts, photos and clock times in this folder are fictional. All seven working days use German local time. Eight playable German voice notes are in munich-demo/03-voice-notes/. Each dictation record links its synthetic WAV via audio_path and its transcript via path. The audio uses the Piper de_DE-thorsten-medium voice (https://huggingface.co/rhasspy/piper-voices/tree/v1.0.0/de/de_DE/thorsten/medium).

Live demo
1. Set the project clock to 11 November at 10:12. Show only records available by that time. Draft a delay notice to the project owner's representative. Use the photo for the visible situation and the foreman's dictation for the stop time.
2. Move to 12:02, then 12:24. Reconcile the uncertain dictation with the quantity ledger. Show both the original note and the corrected result.
3. Advance to 12 November at 08:47 and then 09:20. The drawing release and the physical restart have different times. Deduct the scheduled break from equipment standby. Cost recovery needs separate evidence.
4. On 13 November use the second photo for a notice of concern. Keep the measurement open until a field check. On 17 November generate the proposed price for six additional sleeves and show the pending owner decision.
5. Keep evaluation/ outside the assistant's retrieval index. Use its sixteen dated questions and three example drafts to score the result.

Source folders
01-schedule holds six activities with units, resources, dependencies and daily targets; CSV uses UTF-8 and a comma separator. Daily targets are individual shift quantities. The interim target is in baseline.json.
02-site-diaries holds signed-role shift summaries. 03-voice-transcripts holds eight rough German dictations. 04-correspondence holds meeting minutes, emails, drawing status, field checks and commercial backup. 05-photos contains the two generated PNGs and their prompts.
templates/drafting-prompts.json contains the German drafting instructions.
public-data/sources.json records creators, source locations, access terms and transformations.

Try real records
Upload public-data/ny-field-reports/report-054.pdf. Ask how many loads left that day and what the 585-load figure represents. Page 1 gives zero loads that day and 585 cumulative. Ask why excavation 11 was to be expanded and use page 4 to compare with photographic observations from other work fronts.
For a new source, upload report-056.pdf. Ask which areas were excavated on 10 December and whether any samples were collected that day. See pages 1–2.
Use public-data/cambridge/project-26256-sample.json for immediate import; the full original archive expands to a 1.29 GB JSON file. Use the safety-images/test folder for image detection with matching annotation IDs. Public datasets cover different projects and have no join keys to the Munich scenario.
