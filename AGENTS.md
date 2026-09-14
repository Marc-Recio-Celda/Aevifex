# AGENTS.md — how this company runs

> The orchestration file: which roles exist, what each does, what occasion calls for each, and the rule that
> governs hiring and firing. **Every line here passes two tests** — *if an agent ignored it, would
> the work come out wrong?* and *could it have worked this out by reading the repo?* **Only
> yes-then-no stays** (`AX-29`); there is no notes section and nothing overflows — history is
> the log's (`AX-41`), a trap goes to `skills/company-auditor/traps.md`, and everything else is not
> written.

---

## 1. What this repo is to an agent

Aevifex is the **structure**, and it is the workspace root: this repo tracks only the structural
allowlist in `.gitignore`, while every child folder — **the operations centre** and each project —
is **its own repository, untracked here, forever**. Rules travel with this repo; state never does.
If the operations centre is not present, you are editing methodology and nothing else is in scope.

**Start here, in this order.** `PHILOSOPHY.md` — what this company optimises for, and what breaks
every tie → `AXIOMS.md` — the rules that follow, already settled and not re-litigated → this file,
for who does what and when → **`METHOD.md` — how work actually flows, which is the one you will use
every day** → **`FLOW.md` — the shape the work moves in, and the declared winner for the plan
lifecycle** → the role file for whatever you are about to act as or invoke → **and then the
operations centre, which is where the work is** (§2).

⚠️ **Read what the work needs, not all of it** (`AX-21`). **Designing or auditing loads all three
levels. Executing a defined task loads the binding, the role file, and `METHOD.md` §2 and §7** — the
loop and the routing table, because the close is not optional and its destination vocabulary lives
there. **The axioms are what the close is *checked against*, not what the work is done through**, and
loading all five documents for a defined task displaces the work itself.

**The design pressures and the vetoes live in `skills/company-auditor/`** — the reviewer that
re-runs them at close, and the one place they are written.

**Three levels, and nothing is allowed to blur them.** *Philosophy* — the clauses, changed almost
never, only by the operator. *Axioms* — the rules that implement them, never violated, each naming
the clause it serves. *Decisions* — concrete, with author, date and reasoning, living instance-side
and never here. **The same three levels repeat one floor down inside a project**, with its own
auditor, its own axioms and its own log.

## 2. The operations centre

**Every Aevifex instance has exactly one, and it is where the company actually lives** — the
knowledge, the projects, the decisions, the work in flight, the ledger, the task list, the inbox,
the plan. It is **private**, a sibling folder in this workspace, and **never tracked here**.

> **Aevifex is the constitution. The operations centre is the country.**

**Almost nothing real happens without entering it.** This repo tells you *how* to work; the centre
is *where* the work and its entire record are. An agent that has read only Aevifex knows every rule
and nothing that has ever happened. So the reading order is **learn the rules once, then go where
the work is** — and only *how much* of it loads is variable: its binding always, its contents by the
routing index and never wholesale (`AX-21`).

**Its name is company vocabulary, not a private name.** Aevifex names the role and its conventional
root and names nothing inside it: no project, no person, no path below that root. A stranger
instantiating their own company creates their own, the same way they create their own `main` branch.

**The binding, declared instance-side.** The centre's own contract at its system root — `AGENTS.md`
by default (`skills/build-nexus/layout.md`) — declares **where its ledger lives**, the append-only
log the auditors write to, and **where its denylist lives** for §5's depersonalisation check. The
denylist is a list of names and project words, personal data by definition, so it lives there and
never here. ⚠️ **An arriving agent lists the system root rather than assuming the name**, since instances
differ on it.

## 4. Roles

**A role is a skill with a log and a dismissal criterion** (`AX-11`). The auditors share one contract
in `skills/audit/`; each role file states its scope, the occasion that calls for it, and its own
checks — and **the role file is where those live**, because a skill's description is already loaded
in every context.

⚠️ **The definition above is the whole of it, and it is about accountability.** **The shape of a
description decides something else — how the model reaches the skill** — and the two axes are
independent: a role's description may name a request, and a skill with neither log nor criterion may
name an occasion.

| Its description names | What the model does with it |
|---|---|
| **an occasion** — *"when a task closes"* | recognises it and **says so**; the operator invokes it (`METHOD.md` §5) |
| **a request** — *"when the operator wants X"* | offers it when what was asked for matches |
| either, plus `disable-model-invocation: true` | **the operator calls it by name.** ⚠️ **Its description leaves context entirely** — lock what only he should reach for |

⛔ **An occasion named in prose is a prompt to speak.** The agent names the skill and the occasion;
the operator invokes it.

**Hiring and firing are the operator's act**, and **a role's criterion and standing live in the
operations centre's hiring record** — out of the role's own sight, and read against the role's log.

**Written and available — a skill existing is not a hire.** `gather` (collects and cites; its value
is burning someone else's context) · `dispatch` (hands work to the executor entitled to claim the
answer).

**And *nothing is lost* is a rule at round close** — its context is the whole conversation, which is
the one context no agent can be handed.

## 5. Invariants — each carries its check

| Invariant | The check |
|---|---|
| **No personal information in what git tracks.** No person's name, no employer, no project name, no path inside the operations centre. Naming the centre itself is vocabulary (§2) | `tools/gate.sh` — greps the instance's denylist over `git ls-files`, and returns nothing. ⚠️ **Test it against a planted leak, and plant against the *format*** |
| **The tracked set is exactly the allowlist** — nothing more, and nothing named that does not exist | `tools/gate.sh` check 3, both directions. A **surplus** file is a leak; a `!` line with **no tracked file behind it** is empty scaffolding, and the line goes |
| **`git clean` is never run at this root.** The untracked here is everything the operator owns | none — prevention only (`AX-4`) |
| **Records are append-only; Standing documents are not.** A log, a ledger and a decision store only grow. **`AXIOMS.md`, this file and `METHOD.md` are Standing and are rewritten to stay true** — what protects them is that every change is read as a diff and agreed, not that nothing may leave | `skills/release-cut/` §3 over the Records. ⚠️ **Forcing a Standing file to only grow is how its centre fills with deprecated rows** |
| **Every structural change carries an axiom or a logged decision** | `git diff <last-tag>..HEAD --stat` against the same range's `AXIOMS.md` additions, at the cut |
| **Every queue and park entry carries `project:`** — a name or `cross` | `interface/model/parse.py --adapter <the instance's>` reports **`with project: n/n`** per kind and **`Nothing unplaceable.`** |
| **Every axiom sits in exactly one tier** (company · instance · project) | a company axiom naming a toolchain, a project or a person belongs one tier down; an instance rule copied into more than one project file is a duplicate with no winner (`AX-20`) |
| **Every axiom names the clause it serves, and every clause has at least one axiom** | the coverage table at the foot of each department, **regenerated and compared**, never transcribed |
| **Every role states its dismissal criterion and keeps a log** — the two together are what make it a role | `tools/roles-check.sh --skills skills --logs <the instance's logs dir>`. **The two sets must be the same set**, and each direction is reported separately, because the fix differs by direction |
| **Citation follow-through** (`AX-33`) | `grep -rln '<the id>' $(git ls-files)` gives the dependency list, and `tools/axiom-refs.sh` proves none of them points at a row that no longer exists. ⚠️ **The artefact that breaks loudly is not the risk** — it is the one that still runs and is now wrong |
| **Never push to the stable branch without explicit operator permission** | the binding names the working branch as **a literal value**, and no agent workflow targets the stable one automatically. ⚠️ **A rule whose subject is a phrase cannot be checked; one whose subject is a value can** |

⚠️ **Every check here reads `git ls-files` or a diff, never the working tree** — the tree at this
root legitimately holds the instance and every project, which are none of this repo's business. A
check that walks the tree (`find`, a bare `grep -r`) is wrong by construction here.

⚠️ **These checks run by hand at each cut** (`AX-7`), and §8 holds the gate that changes it.

⛔ **Every invariant here binds this repository too.** The exemption granted to the authoring repo
is the one every later exemption cites, and it is granted by whoever is least able to see the cost
of granting it.

⚠️ **Every check states the root it runs from.** The same correct check run from the wrong root
returns clean, so **a check that cannot state its root has not been run** — and **exit 0, exit 1 and
exit 2 are three different answers** (`AX-22`). The three implementations here are the pattern to
copy.

## 7. Gates

**What runs on its own:**

- **Every close** → every open thread is enumerated with its destination (`AX-9`), and *written* is
  claimed only after reading the file back from disk. **A thread with no destination fails the
  close.**
- **A release is cut** → all §5 checks run, the cold-start test runs, the version is tagged.
  Instances upgrade by choice, never by drift.

**What the agent says, and the operator invokes:**

- **A task closes having changed a structural file** → the agent names **the auditor for the
  department that changed** — one of them, `skills/audit/` routes — and the occasion for it is
  **after** the destinations are read back and **before** the task's sheet is closed (`METHOD.md` §2).
  Each role file states its own two lists: structural, and expressly not structural.

## 8. Stage map

| Stage | Content | Gate |
|---|---|---|
| **1 — done** | skeleton: `PHILOSOPHY.md`, `AXIOMS.md`, this file, `METHOD.md`, the company auditor | cold start: an agent given only this repo explains the company and **can operate its rules** |
| **2 — half done** | ✅ the split executed and the generic halves moved in · ✅ licence and first tagged release · ⬜ **§5's checks still need a human at every cut**, which is the half that decides the stage | **the checks run themselves.** Until then §5 is a documented procedure, and `AX-7` says what that is worth |
| **3 — written** | the operating skills, plus `create-note` — the one door to a knowledge base | each carries its verification as a prediction. ⚠️ **The end-to-end gate has never been run as a test** — the loop has run in practice, which is a different claim |
| **4 — now** | ✅ `compact`, run over the whole tracked set · ⬜ the collaborative-repo pass · ⬜ **the templates the standards ship as** — `AX-26` asks for them and nothing in the tracked set is one | each skill's own prediction |
| **✅ done, out of order** | **`build-nexus`** — the cold start's own subject | a stranger, given only this repo and the skill, ends with a working instance and a first task in flight |
| later | roles beyond those hired, strictly by §4 | each role's own criterion |
