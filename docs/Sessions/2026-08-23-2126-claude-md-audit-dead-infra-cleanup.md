# Session: 23-08-2026 21:26 - claude-md-audit-dead-infra-cleanup

## Quick Reference
**Topics:** /init, CLAUDE.md audit, doc drift, Test_Report stale count, dead Terraform modules, apigateway, authorizer lambda, build.js entries, deploy.ps1 targets, terraform state list, terraform validate, orphan lambda zips, .gitignore, git rm --cached, already-tracked files, git check-ignore, MSYS_NO_PATHCONV, PowerShell -target quoting, AWS credential shadowing
**Projects:** `help_me_backend` — `CLAUDE.md`, `docs/` vault, `infra/` Terraform, `build.js`, `scripts/deploy.ps1`
**Outcome:** `CLAUDE.md` was audited against the tree (no drift found beyond one stale test count) and gained four verified traps. The dead API-Gateway-era stack is gone — `infra/modules/apigateway/`, `infra/modules/authorizer/`, the `authorizer` entry in `build.js` and its `deploy.ps1` target — and every Lambda zip is now untracked, matching the `*.zip` rule that had been sitting unenforced in `.gitignore` all along.

## Decisions Made
- **Audit the existing `CLAUDE.md`, do not rewrite it.** `/init`'s default is to generate a file; this one was deliberately tuned the previous session, so every claim was re-verified against the tree instead and only verified gaps were added. Rewriting would have discarded working knowledge to restate what was already true.
- **Delete `apigateway` + `authorizer` rather than leave them.** Same reasoning as `grant-permission-worker` the day before: a module that nothing instantiates is not documentation of an old design, it is a thing the next reader has to disprove. The design it belonged to is already recorded in [[Architecture/Authentication_and_Audit]].
- **Remove `authorizer` alongside `apigateway`, not separately.** Its only consumer was the API Gateway module's `authorizer_uri`; removing one and keeping the other leaves the same dead stack half-deleted.
- **Route the RDS/security-group traps by `[[wikilink]]` instead of restating them in `CLAUDE.md`.** [[Runbooks/Cloud_Deployment]] already documents `prevent_destroy`, the `DbiResourceId` state key and the inline-vs-standalone rule. A trap written in two places drifts in one of them.
- **Untrack the zips (`git rm --cached`), never delete them from disk.** Terraform reads them by `filename` at apply time; deleting them breaks the next deploy from this working tree.
- **All Lambda zips untracked, not just the seven orphans.** Offered three readings of "ignore those files"; the user chose all. Accepted cost: a fresh clone can no longer `terraform apply` until `npm run build` runs. Beat untracking only the orphans, which would have kept the three live zips as repository content.
- **Left the seven orphan zips on disk rather than deleting them.** `authorizer` was provably dead (no source, no state, no reference); for the other seven I could not rule out a source outside this repo, so they were documented as non-evidence instead of removed.

## Key Learnings
- **`.gitignore` never applies to a file git already tracks.** `*.zip` has been at `.gitignore:37` the whole time while eight zips stayed tracked — they were committed before the rule existed. The rule looked enforced because new zips were correctly ignored. `git check-ignore -v <path>` reports the matching rule and line; `git ls-files '*.zip'` is what actually proves nothing is tracked.
- **`post_confirmation.zip` was already untracked before this session**, so a fresh clone was *already* an incomplete deploy source — the "Terraform consumes checked-in zips" line in `CLAUDE.md` and the vault had been half wrong for some time. It is now uniformly true that no zip is repository content.
- **`infra/modules/` held two modules `infra/main.tf` never instantiates.** `apigateway` (129 lines) and `authorizer` (59 lines + zip) were pre-ALB ingress. `terraform state list` returns **103 resources**, none matching either — that command, not the presence of a directory or a zip, is what proves something is deployed.
- **`build.js`'s `fs.existsSync` guard hid a dead entry in plain sight.** The `authorizer` function pointed at `src/functions/authorizer/handler.ts`, which does not exist; the guard skipped it silently every build, so the leftover produced no error for months.
- **Stale names hide in error strings.** `deploy.ps1:110` still advertised `-Name (authorizer|post-confirmation|audit|notification|grant)` — `grant` had been deleted the day before. A `throw` message is not covered by any type check or test.
- **`node build.js` rewrites zip bytes even when the source is unchanged**, so a doc-only session picks up binary diffs by running it. `git checkout -- <zip>` restores the committed bytes (moot once untracked, but it keeps a diff honest).
- **The auto-mode classifier blocks rewriting files through a Bash `python - <<'PY'` heredoc.** Denied with "Blocked by classifier"; `Read` + `Edit` is the sanctioned path for prose edits. Worth knowing before writing a careful multi-replacement script that never runs.
- **`terraform validate` here is Success-with-warnings by default** — two `aws_service_discovery_service … failure_threshold is deprecated` notices at `modules/ecs/main.tf:165`, unrelated to any change. Do not read them as breakage introduced by your edit.
- **`.gitignore:17–20` still lists `/src/notification_worker.zip`, `/src/twilio_worker.zip`, `/src/write_server.zip`, `/src/read_server.zip`** under a `# Go` heading, beside `test_sms.go` and `notification-worker.exe` — dead lines from a pre-TypeScript era, fully subsumed by `*.zip`.
- **`docs/Testing/Test_Report.md` still reads 75/75** (run 2026-08-22 12:14 UTC) because nothing has re-run since `WK-07` retired with `grant-permission-worker`. The generated file and `CLAUDE.md` disagree, and the file is the stale one.

## Pending Tasks
- [ ] Nothing is committed. Suggested split: (1) remove the dead `apigateway`/`authorizer` stack, (2) untrack the Lambda zips, (3) the `CLAUDE.md` + vault doc updates.
- [ ] Re-run `npm run test:api` to refresh [[Testing/Test_Report]] from 75/75 to the real 74/74.
- [ ] Decide the fate of the seven orphan zips still on disk (`audit_archiver`, `cognito_create_auth`, `cognito_define_auth`, `cognito_verify_auth`, `post_authentication`, `read_service`, `write_service`) — untracked now, so they disappear from any fresh clone regardless.
- [ ] Prune the dead Go-era zip entries at `.gitignore:17–20` if that file is ever touched again.
- [ ] `/init` offered to import `~/.codex/config.toml` and `~/.gemini/GEMINI.md` via `/import`; never answered.

## Project Structure

Tracked files only (`git ls-files`, 168 entries; nothing untracked-and-unignored). Depth follows what
this session touched.

```
help_me_backend/
├── CLAUDE.md                        — map to the vault; gained 4 traps (zips untracked, .env AWS creds,
│                                      dead infra modules, Windows shell arg mangling) + the stale-report note
├── .gitignore                       — `*.zip` at :37 (pre-existing); :17–20 are dead Go-era zip entries
├── .env.example                     — annotated template for the 21 vars the code reads
├── build.js                         — esbuild → zip → infra/modules/lambda/; authorizer entry + its
│                                      destDir removed this session (3 entries, 3 handler dirs)
├── docker-compose.yaml              — db, dynamodb, dynamodb-init, elasticmq, ai-server, write/read servers
├── package.json                     — no linter, no test framework; `npm test` is the Python AI script
├── tsconfig.json
├── docs/                            — Obsidian vault, source of truth
│   ├── 00_Overview.md               — index + question→page map
│   ├── Architecture/
│   │   ├── Code_Layout.md           — EDITED: build section now says zips are untracked build output,
│   │   │                              and the orphan-zip callout was rewritten
│   │   ├── Authentication_and_Audit.md — already records the API-GW authorizer → Express middleware move
│   │   ├── CQRS_Pattern.md, Database_Schema.md, EventBridge_Sync.md
│   │   └── *.canvas                 — System_ and Infra_ architecture maps (Obsidian canvases)
│   ├── Runbooks/
│   │   ├── Cloud_Deployment.md      — EDITED: deploy step 1 comment + a Windows shell-quoting trap
│   │   └── Local_Testing.md
│   ├── Services/                    — Write_Server, Read_Server, AI_Server, API_Reference_and_Tests
│   ├── Sessions/                    — this file is the 5th; archive, never read as a folder
│   └── Testing/Test_Report.md       — GENERATED by test:api; currently stale at 75/75
├── infra/                           — Terraform, real cloud
│   ├── main.tf                      — instantiates 13 modules; modules/ now holds exactly those 13
│   ├── modules/
│   │   ├── lambda/main.tf           — references 3 zips: audit_worker, notification_worker, post_confirmation
│   │   ├── lambda/*.zip             — untracked build output; 7 of the 10 on disk are unreferenced orphans
│   │   ├── ~~apigateway/~~          — DELETED this session (pre-ALB ingress, never instantiated)
│   │   ├── ~~authorizer/~~          — DELETED this session (its only consumer was apigateway)
│   │   └── ai_service, alb, auth, bastion, cloudfront, dynamodb, ecs, eventbridge, rds, s3, sqs, vpc
│   └── terraform-deploy-policy.json
├── local-infra/                     — Serverless-offline emulation (S3, EventBridge, offline Lambda);
│                                      runs on the HOST, never deployed
├── prisma/                          — schema.prisma (8 models) + seed.ts
├── scripts/
│   ├── deploy.ps1                   — EDITED: authorizer target removed; -Name hint no longer offers
│   │                                  `authorizer` or the already-dead `grant`
│   ├── cloud-start.ps1 / cloud-stop.ps1
│   └── connect_to_rds_through_bastion_host.md
├── src/
│   ├── functions/                   — audit-worker, notification-worker, post-confirmation (3 handlers)
│   ├── services/
│   │   ├── write-server/            — :8080 Express, 8 route files
│   │   ├── read-server/             — :8081 Express, 9 route files + session.service.ts
│   │   └── ai-server/               — Python SQS consumer; anti_spoofing/, edgeface/, face_landmark/
│   │                                  are VENDORED model code — do not edit
│   └── shared/                      — db/, middleware/auth.ts, services/ (ai, events, hash, job, mask,
│                                      provision, s3) — one change here reaches every deployable
└── test/
    ├── api-test/                    — 74 in-process checks across 9 groups; README.md is the catalogue
    └── ai-test/                     — pipeline_probe.ts, presign_check.ts, process_images_to_json.py
```

---

## Raw Session Log

**User:** `/init` — "Please analyze this codebase and create a CLAUDE.md file…"

Found an existing `CLAUDE.md` (and no `README.md`, `.cursor/rules`, `.cursorrules`, or
`.github/copilot-instructions.md` in this repo), so audited rather than generated. Re-verified every
claim against the tree:

- four-deployable table matches `src/` (3 Lambda dirs after `grant-permission-worker`) ✓
- `src/shared/middleware/auth.ts:60` really is `if (SKIP_AUTH && headerId)` ✓
- `test/api-test/index.ts:8` assigns `SKIP_AUTH` before the `event_capture` import at `:12` ✓
- all vault pages listed exist; the three `npx tsx` checks exist ✓

Discrepancies and gaps found:

```
docs/Testing/Test_Report.md:  **Result:** 75/75 passed (100%)   ← CLAUDE.md says 74/74
infra/modules/lambda/         12 zips, main.tf references 3
infra/main.tf                 13 `module "…"` blocks; apigateway + authorizer never instantiated
build.js:12                   { name: "authorizer", entry: "authorizer/handler.ts", … }  ← no such handler
.env                          contains AWS_ACCESS_KEY_ID (dummy `test`) → leaks into terraform/aws CLI
```

Proposed five edits (stale-report note, `.env` credential trap, dead-infra bullet, Windows shell
quoting, and a wikilink to the runbook's RDS/SG traps).

**User:** ok

**User** (mid-turn): and consider remove apigateway (if can)

Verified before deleting anything:

```
$ terraform state list | grep -i "apigateway\|authorizer"   → no matches
$ terraform state list | wc -l                              → 103
```

Also confirmed `docs/Architecture/Authentication_and_Audit.md:9` already records the transition from
an API Gateway Lambda Authorizer to inline Express middleware behind the ALB.

Removed: `infra/modules/apigateway/`, `infra/modules/authorizer/`, `infra/modules/lambda/authorizer.zip`,
the `authorizer` entry + `authorizerModuleDir` in `build.js`, the `authorizer` target in
`scripts/deploy.ps1` and its `-Name` hint string, and the "four functions, three directories"
paragraph in `Code_Layout.md`.

An attempt to apply the `build.js`/`deploy.ps1` edits through a Bash `python - <<'PY'` heredoc was
refused:

```
Permission for this action was denied by the Claude Code auto mode classifier. Reason: Blocked by classifier.
```

Re-did them with `Read` + `Edit`.

Verification:

```
$ node build.js
✅ Built JS bundle for: audit-worker / notification-worker / post-confirmation
🎉 Lambda build and packaging complete!

$ terraform validate
Success! The configuration is valid, but there were some validation warnings as shown above.
  Warning: Argument is deprecated — modules\ecs\main.tf line 165, failure_threshold  (pre-existing)
```

`git checkout --` restored `audit_worker.zip` / `notification_worker.zip` to their committed bytes,
since `node build.js` had rewritten them with no source change.

**User:** hey hey ignore those files .zip

Ambiguous between "drop the topic" and "add to `.gitignore`", and the gitignore reading has a real
consequence, so asked. User chose **"Gitignore all lambda zips"**.

Discovered the rule already existed:

```
$ cat .gitignore | sed -n '37p'      → *.zip
$ git ls-files '*.zip'
infra/modules/authorizer/authorizer.zip
infra/modules/lambda/audit_archiver.zip
infra/modules/lambda/audit_worker.zip
infra/modules/lambda/authorizer.zip
infra/modules/lambda/cognito_create_auth.zip
infra/modules/lambda/cognito_define_auth.zip
infra/modules/lambda/cognito_verify_auth.zip
infra/modules/lambda/notification_worker.zip
```

Eight tracked because they predate the rule; `post_confirmation`, `post_authentication`,
`read_service`, `write_service` were already untracked. Ran `git rm --cached` on the six survivors
and staged the two authorizer deletions.

Then corrected every "checked-in zips" claim: `CLAUDE.md`'s trap bullet (now both directions — a
fresh clone has none and fails on a missing `filename`; an old tree has stale ones that apply as old
code), `Code_Layout.md`'s build section and orphan callout, and `Cloud_Deployment.md:217`.

**User:** did you appropriately ignore those files?

Verified rather than asserted:

```
$ git check-ignore -v $(find infra src local-infra -name '*.zip')
.gitignore:37:*.zip	infra/modules/lambda/audit_archiver.zip
… (all 10 matched by the same rule)

$ git ls-files '*.zip'                                    → empty
$ git status --porcelain --untracked-files=all | grep '^??'  → none
```

Flagged the dead `.gitignore:17–20` Go-era entries and the fact that repo-wide `*.zip` silently
ignores any zip added deliberately later — which is exactly why eight of them sat tracked for months
without the rule ever pushing back.

**User:** /compress
