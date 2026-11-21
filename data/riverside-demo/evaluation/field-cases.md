# Riverside field cases for 13 November 2026

Use live API mode, open Incidents and set the replay clock to the indicated Vienna time. Compare the model's citations and meaning with these checks. Wording and confidence scores can vary.

| Time | Incident | Expected result |
| --- | --- | --- |
| 07:45 | West wing pour on hold | Two finishers are waiting. The foreman says the inspection sticker on pump P7 expired (V11). The field note supports an inspection hold. It does not establish a mechanical failure. |
| 08:20 | West wing pour on hold | The site manager independently confirms the expired inspection in the register (E05). Earlier replays must exclude E05. |
| 09:30 | Zone B spacer delivery late | Four workers are waiting (V12). Dispatch estimates a 10:30 arrival (E06). The incident is open and the cause is unknown. |
| 10:30 | Zone B spacer delivery late | The forecast time has passed. The truck has no recorded arrival yet. |
| 10:45 | Zone B spacer delivery late | The gate docket (G13, page 1) records arrival at 10:45. The incident is resolved. The reason for the delay is still unknown. |
| 10:50 | Zone B spacer delivery late | The site manager corroborates the gate docket (E07). This is the same delivery. |
| 11:00 | Zone B survey tablet stopped saving | One surveyor is waiting (V13). The tablet stopped saving readings. The cause is undetermined. The pump and delivery records describe different incidents. |

Original WAV, email and PDF files are under `uploads/`. Reference transcripts are under `transcripts/`. From the backend folder, `python seed_field_cases.py` adds these cases to an existing seeded Riverside project in one transaction. Repeating the command preserves existing records.
