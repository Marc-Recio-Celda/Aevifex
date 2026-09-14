---
name: structure-project
description: Creates a project's cartridge under the method — definition, objectives, plan, decision log, agent log, and its own axioms once it has one — plus the agent contract where the repository is owned; when a new project starts or when work already underway is brought under the method for the first time.
---

# structure-project

## Occasion
**A new project starts**, or a body of work already underway is brought under the method. One
firing produces **one cartridge and nothing else** — no wall row, no `▶`, no task.

**Where it writes:** the operations centre, at its projects root. **Path shapes only — the literal
root is the instance's, declared in its binding.**

## The procedure

**0. Create `<project>/nexus/` — the folder, before any file.** ⛔ **Step 1 copies into it; it does
not create it.** ⚠️ **This step exists because the rule below was stated once, in the preamble, and
the files were written one level up anyway** — reported by the operator 2026-09-05 across a whole
the projects root (`98_PROJECTS/`). **A constraint named in a preamble and absent from the step it constrains is a
convention, not a rule**, and this is the same shape as every *published check that cannot match* in
this company's log. The fix is the same one every time: put it where it fires.

**Check, before step 1:** `test -d <project>/nexus && echo ok` → `ok`.

⚠️ **The cartridge's file names changed 2026-09-05 (`M-135`) and this skill was rewritten with
them:** `state.md` → **`plan.md`** (it was 53 % plan and 5.5 % present-tense, measured across ten
cartridges) and `architecture.md` → **`axioms.md`** (it holds rules, and the two departments above
it were already called what they are). ⛔ **A cartridge opened today carries the new names.** A
cartridge that still has the old ones is *not migrated*, which `coherence.py` reports as such — never
as missing. A project directory with no
`nexus/` is an incomplete creation, and `build-nexus` reports it whoever made it.

**0b. Read the finished projects before writing a rule.** ⛔ **A project opened without reading the
others repeats their mistakes and loses their wins**, and it is measurable: **276 decision records in
the store, 67 with a non-empty `discarded`, and a project opened today reads 0.** It has already cost
something countable — *one home per rule* was learned once, and a later project then arrived at the
same shape twice on its own: **the same lesson, three arrivals, and no citation between any of
them.**

Read every sibling's `axioms.md` and the `Discarded` field of its `Decision_Log.md`. **What you are
looking for is a rule that already solved a problem this project is about to have**, and each one you
take is written into the new axiom's own row **naming where it came from** — `<project>:AX-n` — so
the second arrival is visible as a second arrival.

⚠️ **The trap, and it will silently return nothing.** Two axiom formats are in use — a table row
`| **AX-n** | 🟢 | …` and a heading `### AX-n — …` — so **a sweep with one pattern reads zero over
the projects that use the other**, and reports them as having no rules rather than as unread. Match
both, and **report the per-project counts** so a zero has to be looked at instead of assumed:

```bash
# from the projects root. Two patterns, and the count is per file, never a total.
for f in */*/nexus/axioms.md */nexus/axioms.md; do
  [ -f "$f" ] || continue
  t=$(grep -cE '^\| \*\*AX-[0-9]+\*\* \|' "$f")        # table rows
  h=$(grep -cE '^#{2,3} AX-[0-9]+ ' "$f")                # heading rows
  printf '%-52s table %-4s heading %s\n' "$f" "$t" "$h"
done
```

⚠️ **The status column is deliberately not in the table pattern, and the first version of this
snippet had it.** Matching `\| (🟢|⚫) \|` returns **zero on every project** the moment one of them
uses a status glyph the pattern does not list — which is a sweep that reports *nine projects with no
rules* and looks like a finding instead of a bug. **Match the id and the row; read the status with
your eyes.**

⛔ **A project reported with zero in both is read by eye before it is believed** — an empty axiom file
is a real state (`METHOD.md` §5: `axioms.md` is created when the first one exists), and it is not the
same state as a file this sweep could not parse.

**What comes out of this step**: a short list of *inherited from `<project>:AX-n`, and what it saves*,
which goes into step 3. **An empty list is a result** — say so — but it is a rare one, and a project
whose first axiom department cites nothing has usually not looked.

**1. Copy the template.** The cartridge is copied, never typed (`Aevifex:AX-26`). Copy it whole **into
`<project>/nexus/`**, then
substitute every placeholder — the project's name, its path, its own `AX-n` series — in one pass.
**A placeholder that survives the copy is a defect, not a to-do.**

**Every file below goes in the project's `nexus/` folder**, which is the cartridge — the project's
own directory holds its code and its data, and `nexus/` holds what governs them.

**The cartridge's files and what each holds are `Aevifex:METHOD.md` §2's.** What this procedure adds
is **when two of them are created at all**: `axioms.md` and `skills/` **open with their first
entry and never as an empty container.**

**2. Fill `definition.md`, and purpose comes before mechanism.** ⛔ **What this project is for, and
what it refuses, is written before any procedure** — purpose is what breaks a tie when two rules both
apply, so it goes where it is read first. Measurable objective · context · deliverables and their format ·
success criteria · constraints · data available. **Then, in its own section, what this project is
not.** The negative half is written now, while the boundary is still visible to the author: **it
keeps scope from arriving unannounced, and no later pass can reconstruct it** (`Aevifex:AX-4`).

**3. Open `axioms.md` — the project's own axiom department.** It opens with at least one rule
or it is not opened at all; **an empty axiom file reads as *this project has no constraints*.** Each
entry is numbered in the project's own series, bare inside this file and anchored the moment it is
cited anywhere else (`Aevifex:AX-31`), and each names the clause it serves. Which rules belong here is
settled by the placement test below.

**4. Open `Decision_Log.md`.** Parseable from the first entry, with the field contract in the file's
own header (`Aevifex:AX-2`); every entry carries author, date, reasoning and **what was discarded**
(`Aevifex:AX-24`). **The first entry is the one that created the project:** why it exists, and what
shape was rejected for it.

**5. Open `objectives.md` and `plan.md`.** ⛔ **They are two files because they change at two
rates** (`Aevifex:AX-39`), and this step is where the split is honoured or lost.

- `objectives.md` — **what the project is trying to achieve now.** One entry each, with **why it is
  an objective and not a task** and **what met looks like**. ⛔ **It is not derivable from the
  repository**: an objective is a judgement, so this is the file the operator writes and an agent
  may only record. ⚠️ **An objectives file that is incomplete says so** — the ten cartridges that
  came out of `M-135` with none at all is what this step exists to stop repeating.
- `plan.md` — the blocks and sub-blocks that move those objectives, the active risks with the
  fallback agreed for each. ⛔ **Every block names the objective it serves**, and a block that
  serves none is a block nobody decided to do.
- ⛔ **The state is not a document.** It is the position inside the plan — which sub-blocks have
  been promoted to the wall and which carry the `▶`. **A state you maintain goes stale; a state that
  is a position cannot.** A cartridge opened today has no `state.md`.

**6. Place the agent contract — only in a repository the operator owns.** It holds what is true of
**this** repository and reaches the method by reference: it is the one file naming where Aevifex
lives, and every rule it needs from there is cited, never copied (`Aevifex:AX-20`).

- **Owned** → at the root of the code repository, local half filled: build and test commands, the
  working branch, the invariants that hold only here and the check for each.
- **Not owned** → **it is not dropped in.** Adding a file to someone else's repository is exactly
  the unrequested change the ownership class exists to stop (`Aevifex:AX-19`). The contract stays in
  the cartridge; observations about that repository go to its owners, not into this instance's
  queues.

**6b. Add the project's name to the instance's denylist, and prove the gate fires on it.** A new
cartridge introduces a new **private identifier**, and the depersonalisation gate greps a fixed list
of words: **a name nobody adds is a name the gate cannot see, and it returns clean on a real leak.**

**Adding the word is not the step. Proving the pattern matches the name as spelled is.** A term can
sit on the list for weeks and still fail to match the directory it names — **a `\b` boundary does
not exist between a letter and a digit**, so a name ending in a version number escapes a bare word
match.

```bash
# `bash <script>`, never `./<script>` — the execute bit is not part of the check, and a
# sync or a checkout that drops it turns a working script into "Permission denied".
bash tools/denylist-coverage.sh --denylist <the instance's> --projects <its projects root>
```

**Empty is the only passing result**, and **exit 2 means the check did not run — which is not a
pass.** Then plant the new name into a tracked file and watch `tools/gate.sh` block it. ⚠️ **The two
are not the same test and neither substitutes for the other:** coverage asks whether the gate *can*
see the name, the plant asks whether it *does*.

⛔ **This step assumes the project's name is a private identifier, and that is not always true.**
A project called `Notebook`, `Portfolio` or `Trading` is a **dictionary word the public method has
to be able to say** — adding it to the denylist would make the release gate fire on legitimate prose,
which is the same defect that made check 2 of `tools/gate.sh` block the operator's own commits in
September. **When the name is method vocabulary, do not add it: report it, and say plainly that the
gate cannot see this project's name.** A stated hole beats a broken gate, and it beats a silent one
by more.

**7. Do NOT put the project on the wall.** ⛔ **A cartridge arriving is not a commitment**, and the
wall holds commitments. A sub-block reaches the wall when somebody **promotes** it — that is the
operator's act, and it is the whole distinction `Aevifex:FLOW.md` exists to keep
(*asked what was pending, one agent answered 4 and another ~50, and both were right*).

⚠️ **This step said *register the project in the compass* until 2026-09-05 and both halves were
wrong.** The compass was replaced by the wall (`M-135`), and *exactly one active front across every
project* went with the live plan file that made it necessary — **several tasks may be active now.**
A skill that still registered a row would have put an unstarted project onto the board of what is
being done.

Anything this structuring turns up that is not this task leaves with a destination from the closed
vocabulary, one line, **with `project:` filled in** (`Aevifex:AX-25`).

## ⚠️ The live set stays central

**Which live artefacts are central and which Records stay with their project is `METHOD.md` §5's.**
⛔ **Creating a per-project copy of one is the single most likely failure of this procedure**, and it
fails twice over: the copy is a duplicate with no declared winner (`Aevifex:AX-20`), and **its entries
are invisible to the `project:` filter that is the whole point of centralising.** Prediction 2
checks it mechanically, and is worth running even when one agent wrote the cartridge in a single
pass.

## Placing the project's first rules

**The placement test is `METHOD.md` §6's**, and **placing a rule is the case that loads all three
departments whole** — so run it with all three open.

## Verification — stated as a prediction, then run

Write the predictions **before** running anything; the executor returns the real output and **the
gap is the finding** (`Aevifex:AX-14`). **Plant one fault and confirm each check catches it before
trusting a clean run** (`Aevifex:AX-7`).

| # | Prediction |
|---|---|
| 1 | Listing the cartridge returns `definition.md`, `objectives.md`, `plan.md`, `Decision_Log.md` and `LOG_AGENTS.md`, plus `axioms.md` and `skills/` only where they have content, plus the agent contract only where step 6 leaves it there |
| 2 | Searching the cartridge for the central queue and park filenames returns **nothing** |
| 3 | Searching the cartridge for template placeholders returns **nothing** — and for `state.md`, `architecture.md`, `workflow.md` too: those names are retired, and a cartridge carrying one was copied from a template nobody migrated |
| 4 | `axioms.md` holds ≥ 1 axiom; every one is bare, every foreign rule cited in it is anchored |
| 5 | `Decision_Log.md` holds ≥ 1 entry, and its header states the field contract |
| 6 | **The wall has NOT gained a row.** A cartridge is not a commitment, and prediction 6 used to assert the opposite |
| 7 | Every new queue or park entry carries `project:` — entry count and `project:` count match |
| 8 | The agent contract sits at the code repository root **iff** the operator owns it; otherwise in the cartridge and nowhere else |
| **10** | **The harvest ran and its per-project counts are non-zero in exactly one format each.** ⛔ **A project reporting zero in both is unread, not ruleless** — and if the new `axioms.md` cites no sibling at all, step 0b says so out loud rather than leaving the absence to be read as *nothing applied* |
| **9** | **The denylist coverage check returns empty**, and the new name, planted into a tracked file, makes the release gate fire. **A name added and never tested is a name that may still be invisible** |

**An unrunnable check is reported unrun** (`Aevifex:AX-22`).

## What it does not do

- **Create anything central.** It writes into the existing central set; it never creates a second one.
- **Hire the project's auditor** — its own act, under `Aevifex:AX-11`, with the dismissal criterion
  fixed before the first firing.
- **Touch a repository the operator does not own** (`Aevifex:AX-19`).
- **Set the active front, or add any row at all to the wall.** Promotion is the operator's act.
- **Amend the company or instance axiom files.** A rule that fails the project test is **proposed
  upward, never written upward.**
