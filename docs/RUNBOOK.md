# Play Store Contract Breakage Runbook

Google Play changes its page structure without notice. When it does, the recorded
fixtures still parse but the live pages no longer match the paths in `specs.ts`.
This runbook turns that break into a fifteen minute patch.

1. **Signal.** The scheduled `Live contract tests` workflow fails and an issue
   labeled `contract-breakage` appears, or users report a `SpecError`. The issue
   names every failing suite in its title and lists each failing test with the
   `SpecError` field lines (broken fields and the paths that were tried) inline,
   so triage starts without opening the run log.

2. **Refresh and reproduce.** Run `pnpm fixtures:update`, then `pnpm test`. The
   failing tests throw `SpecError`s that name every broken field and the paths
   that were tried. Scope the refresh to the features named in the issue title
   with `pnpm fixtures:update <feature>` (for example `pnpm fixtures:update app`)
   to skip re-recording unaffected suites.

3. **Repair the paths.** Open the matching `src/features/<name>/specs.ts`, inspect
   the refreshed fixture (search the expected value in the raw HTML or batch
   payload to find its new indexes), and update only the paths. Prefer appending
   the new path before the old one so both page generations keep working during
   rollout.

4. **Check moved blocks.** When a whole `ds:` block moved, inspect
   `AF_dataServiceRequests` in the refreshed fixture. One RPC ID may bind several
   `ds:` blocks. The parser evaluates every block bound to the declared RPC ID
   and selects the only candidate that passes the root's structural schema. If
   the RPC ID changed, update the root spec's `rpcId`. Do not change it merely
   because the absolute block key moved.

5. **Verify and ship.** Verify with `pnpm test && pnpm test:e2e`, commit as
   `fix(<feature>): repair <field> paths after play store change`, merge, and let
   Release Please cut the patch.

6. **Close out.** Close the breakage issue with a link to the fix commit.

## RPC anchor diagnostics

An `rpc-anchor-fallback` integrity event means no block reached through the
declared RPC ID passed structural validation, but a declared absolute `ds:`
fallback did. Treat the event as an early contract-drift warning even when the
public result still looks correct.

1. Refresh only the affected fixture with `pnpm fixtures:update <feature>` and
   reproduce with `pnpm test`.
2. Inspect `AF_dataServiceRequests` and list every key bound to the event's RPC
   ID. Compare each block with the root schema and the recorded fixture before
   changing the anchor.
3. Update the `rpcId` only when Google changed the stable RPC ID for the same
   response semantics.
4. Update an absolute fallback only after confirming that the new block carries
   the same semantic root. Keep still-valid fallbacks during a rollout.
5. Add or update an in-memory routing mutation that moves the root, reverses
   routing order, and proves no fallback event is emitted on the repaired route.

An ambiguity `ParseError` names two or more routed keys because more than one
candidate passed the structural root schema. Routing-table order must not decide
the winner. Inspect the candidates and tighten the schema around stable root
structure until exactly one validates; do not pick the first key or delete a
valid route to silence the error.

The other integrity reasons have narrower responses:

- `optional-section-parse`: refresh the fixture and inspect the named
  best-effort section. Required fields and roots must still fail loudly.
- `pagination-token-cycle`: preserve the captured request sequence, confirm the
  repeated token, and inspect the pagination response before changing token
  extraction. Tokens must never be written to logs or event messages.
- `section-anchor-fallback`: the exact match card resolved outside its declared
  anchor. The event message names the section and index where it was found.
  Refresh the search fixture, move `EXACT_MATCH_MAPPINGS.card` to the reported
  index, and confirm the event stops. The public result is already correct, so
  this is a scheduled repair rather than an outage for consumers, but leaving it
  unrepaired means the next drift has no anchor left to fall back from. The
  exact match tripwire below therefore fails the live run on it, the same way
  the suite already fails on `rpc-anchor-fallback`, so that the repair is
  actually scheduled rather than accumulated.

## Live contract assertion rules

The scheduled suite exists to catch scraper breakage, not catalogue movement. An
assertion that fails because Google reshuffled its catalogue creates a false
`contract-breakage` issue and trains everyone to ignore the signal. By default
an assertion under `e2e/` must therefore stay true no matter what Google serves
today, which leaves four ordinary kinds:

1. **Shape.** A field exists with the right type, a url resolves to the store
   origin, an icon is served over https.
2. **Cross-field consistency.** Two fields that come from _different_ page
   nodes have to agree: `free` against `price` and `currency`, `score` against
   `scoreText`, `installs` against `minInstalls`, the histogram against the
   rating count. These are the sharpest breakage detectors in the suite because
   a drifted path breaks the agreement immediately while catalogue movement
   never does. Two fields parsed from the same node are not an invariant, they
   are a tautology: `offersIAP` and `IAPRange` both read `[1, 2, 19, 0]`, so
   only the shape of `IAPRange` is worth asserting.
3. **Self-anchoring.** The assertion derives its expectation from the same
   response, for example `list({ num })` returning exactly `num` items or the
   search result set matching the first page it was built from.
4. **Immutable fact.** A release date already in the past, an app id that
   resolves forever, a category id that is part of the taxonomy constant.

Two further kinds are deliberate exceptions that do detect external change, so
each one has to be registered in this runbook before it is written:

5. **Controlled anchor.** A listing this repository's maintainer owns, such as
   `com.adex77.WhereAmI` or the `Adex77` developer id. A change there is a
   deliberate change by the person reading the failure, not a surprise. Prefer
   this over any pool whenever an owned listing can carry the state.
6. **Regime tripwire and maintained anchor pool.** A documented probe of
   Google's serving behaviour, listed under "Serving regime tripwires", or a pool
   that guards a state no owned listing can reach, listed under "Maintained
   anchor pools". These fail on purpose when Google changes, and their failure
   messages have to name the maintenance task rather than read as a parse break.

Outside those two registered exceptions, never assert third-party catalogue
state. Concretely, do not pin how many apps Google recommends for a listing,
how many apps a developer publishes, whether a specific app currently has zero
reviews or zero ratings, whether a category is currently empty, whether a game
is still in preregistration, or where an app ranks for a search term. Assert the
invariant that holds in either state and let the test follow the catalogue.

When a state still deserves live coverage, branch on what the page actually
reports instead of assuming a state:

```ts
if (listing.ratings === undefined) {
  expect(page.data).toEqual([]);
  return;
}
expect(page.data.length).toBeGreaterThan(0);
```

Report which branch ran with vitest's `annotate` so a reader of the run can see
that coverage moved, without the run failing over it.

### Counting rules

Counts are where catalogue state sneaks back in, so they get their own rules.
Issue #116 came from a suite that demanded a hundred apps from Google's own
developer page. Measured on 2026-09-10, two consecutive calls returned 94 and
then 95 apps, with different sets and 84 of 94 positions reordered, so no fixed
number could ever have been right.

1. A count **ceiling or equality** against third-party catalogue state is never
   allowed. `num` is a ceiling this library controls, so `length <= num` is an
   invariant; `length === num` is one only when the same response proves the
   catalogue reaches that far.
2. A count **floor** is allowed only as a partial-parse detector, and only when
   it sits at or below half the measured value, or when a serving regime
   constant registered below backs it. A floor exists so that a drifted path
   returning one item fails; it is not a claim about how much Google publishes.
3. "A continuation was followed" is expressed against the first page of the
   same surface, never against a constant. Fetch that page with
   `fetchDeveloperFirstPage`, `fetchSearchFirstPage` or `fetchSimilarFirstPage`,
   then hand it to `expectContinuationContract`, which requires the aggregate to
   stay within the requested limit and to exceed the page it continued from.
   A probe whose first page stops carrying a token fails with a message naming
   the re-anchor task, because that is a serving regime change and not a parse
   break.

Two shapes follow from those rules and are worth copying. `num` equal to the
live first page count must return exactly that page, and `num` one past it must
return exactly one more item, which pins the slice at the sharpest place there
is, the cluster boundary. Both derive every number from the same run, so they
hold whether the catalogue grows or shrinks.

Exact slicing beyond the boundary belongs offline, where it is deterministic:
`src/features/developer/developer.test.ts` already proves `num` 13 across a
recorded continuation and `num` 5 when the first page satisfies it.

### Shared invariants

`e2e/contracts.ts` holds the invariant helpers. Reach for them before writing a
bespoke loop of assertions, and add to them when a new cross-field agreement
turns up:

- `expectAppItemContract` and `expectAppItemsContract` for search, list, similar
  and developer items.
- `expectListingContract` for a full `app()` result, which composes the offer,
  offer node, rating, histogram, installs, purchase and release state
  invariants.
- `expectReviewContract` and `expectReviewsContract` for review pages.
- `expectContinuationContract` for a paginated aggregate measured against the
  first page it continued from.
- `expectSearchListingAgreement` for a search item measured against the same
  app's listing, which catches drift on either surface.

The offer fields deserve their own note, because they are the one place where
absence carries meaning. `price`, `currency` and `priceText` are three sibling
indices of a single offer node, and `originalPrice` and `discountEndDate` hang
off the same parent. When Google serves no offer node the parser falls back to
`price` 0, `free` false and `priceText` "Free", so an undefined `currency` is
the signal that the whole node was missing. `expectOfferNodeConsistency` asserts
that implication on every listing: it fires the moment one of those indices
drifts while its siblings still resolve, and never fires when a listing changes
what it costs.

A consequence worth stating plainly: `free` false is not the claim "this app
costs money", because an offerless listing also reads as `free` false with
`price` 0. Read `currency` first when deciding which state a listing is in.

Three thresholds in the suite are measured, not guessed, all on 2026-08-26:

- The histogram tracks the rating count to within `max(10, 1% of ratings)`,
  measured across listings from 31 to 242 million ratings.
- `scoreText` is the score rounded to one decimal, so it agrees to within 0.051
  once the locale decimal comma is normalized.
- `DATA_RICH_COLLECTED_FLOOR` in `e2e/datasafety.e2e.test.ts` is 10 against 37
  entries measured on `com.instagram.android`, so a partial parse of the
  collected data section fails while an ordinary policy edit does not.

Two localized formats decide whether a check runs at all. The install count
comparison only runs when the string is plain grouped ASCII digits, so a
storefront that abbreviates the tier (`10万+`) or uses Arabic-Indic digits skips
the equality instead of comparing a value it cannot read. The `IAPRange` shape
check accepts any Unicode decimal digit, because the Arabic storefront serves
`‏١٢٫٩٩ ج.م.‏ - ‏١٢٬٢٤٩٫٩٩ ج.م.‏ لكل عنصر` and the Japanese one serves
`￥50～￥57,800/アイテム`.

Re-measure with `pnpm coverage:live` and a scratch probe before moving any of
them.

### Maintained anchor pools

A state that needs a live true branch belongs on a controlled anchor whenever an
owned listing can reach it. `com.adex77.WhereAmI` carries `adSupported`,
`offersIAP`, and every optional media field (`video`, `videoImage`, `IAPRange`,
`released`, `contentRatingDescription`, `recentChanges`), so those gates sit on
it directly rather than on a pool of third-party apps.

Two states have no owned anchor, because Google decides both and neither can be
arranged for a maintainer's own app:

- `EXACT_MATCH_CARD_CANDIDATES` in `e2e/search.e2e.test.ts` must keep one
  package id whose search serves an exact match card. It is registered under
  "Serving regime tripwires" above, where its re-anchoring task is written out.
- `PLAY_PASS_CANDIDATES` in `e2e/edgeCases.e2e.test.ts` must keep one title in
  Play Pass. It runs against four titles and fails only when all four have left,
  which is the only live gate on the `[1, 2, 62]` path.

The play pass failure message says "re-anchor the pool". That is a maintenance
task, not a
scraper break: replace the drifted ids with listings that are in the wanted
state and commit as `test(e2e): re-anchor the play pass pool`. Never delete the
pool assertion instead, since dropping it leaves `isAvailableInPlayPass` with no
live coverage of its true branch.

`PREREGISTRATION_CANDIDATES` deliberately carries no such gate. Preregistration
listings launch, so the suite asserts the state conditional invariants on each
candidate and annotates how many are still unlaunched. Both branches of the
parser are covered offline in `src/features/app/app.test.ts`, so a fully
launched pool costs live coverage but never fails the run.

Preregistration and the offer node are independent, and conflating them broke
the scheduled run once already. Measured on 2026-08-28,
`com.ironhidegames.android.kingdomrush6.genesis` preregistered while serving a
full `[0, "USD", ""]` offer tuple, while three other candidates preregistered
with no offer node at all. Carrying an offer node is the publisher's choice, not
a property of the release state, so never assert one from the other.

Refresh that list from Google's own preregistration shelf, which search does not
surface:

```
https://play.google.com/store/apps/collection/promotion_3000000d51_pre_registration_games?hl=en&gl=us
```

Scrape the `id=` parameters out of that page, confirm `preregister` on a handful
with `app()`, and commit the replacements as
`test(e2e): refresh the preregistration candidates`.

## Serving regime tripwires

Three e2e tests pin the current Google Play serving regime instead of the code:

- `confirms google still serves an exact match card for a package id search` in
  `e2e/search.e2e.test.ts`
- `confirms google still serves no search continuation token` in
  `e2e/search.e2e.test.ts`
- `confirms the numeric first page still requires a continuation` in
  `e2e/developer.e2e.test.ts`

The exact match tripwire is the only live gate on the card path. The card is
parsed by `exactMatchSpecs`, which shares no path with the ordinary result
specs, and four of its fields have a single source each in the page, so a
drift there deletes the top result silently. `developerId` is produced by
`exactMatchSpecs` alone, so a first result carrying one proves the card path
ran rather than the list happening to rank the app first. No owned listing
can carry this state: measured on 2026-09-11, a package id search for
`com.adex77.WhereAmI` serves a list and no card in both the `us` and `pl`
storefronts, so `EXACT_MATCH_CARD_CANDIDATES` is a maintained pool under the
rules above and fails only when every anchor has lost its card. Re-anchor the
pool against package ids Google still serves a card for and commit as
`test(e2e): re-anchor the exact match pool`. Never delete the assertion
instead, since dropping it leaves the card path with no live coverage at all.

Two measured serving limits back the count assertions that surround them:
`FIRST_PAGE_SIZE` (150 reviews) in `e2e/iterators.e2e.test.ts` and
`LIST_MAX_ITEMS` (200 apps) in `e2e/list.e2e.test.ts`. `LIST_MAX_ITEMS` is the
hard ceiling `list` returns however large `num` gets, measured identical at
`num` 200, 250 and 500 on 2026-08-26, so the assertion is exact and moves only
when Google moves the cap. Re-measure the page directly before changing one.

Every other page size the suite needs is read live rather than pinned, because
a page size that is asserted as a constant fails the day Google resizes a page
that the parser still reads correctly. Measured on 2026-09-10, for reference
only: the numeric developer first page serves 10 apps and a token, the similar
cluster's first page serves 50 apps and a token, and an English search first
page served 30 results for "geography quiz" and 20 for "panda", identical
across four consecutive calls each.

The exact counts `e2e/list.e2e.test.ts` asserts are the one place a fixed
number still sits against a Google-served set, and they stay because a top
chart is a ranking window over a huge pool rather than one publisher's shelf.
Measured at `num` 250 on 2026-09-10, every chart the suite touches filled to
the 200 item cap: TOP_FREE and TOP_PAID for GAME, TOP_PAID for APPLICATION,
GROSSING, age filtered FAMILY, and SOCIAL. Only GAME_TRIVIA ran shallower at
162, and the suite asks it for five. Re-measure with the same probe before
raising any `num` in that file.

A tripwire failure means Google changed the serving regime, not that the code
broke. The count assertions in the surrounding suites rely on the premises these
tests pin, so re-port the affected contract before touching any threshold.

Two of the three tripwires live in `e2e/search.e2e.test.ts` and fail for
unrelated reasons. The continuation token one is answered by the procedure
below. The exact match card one is answered by re-anchoring the pool as
described above it.

When the search continuation token tripwire fires because a token returned:

1. Open `play.google.com/store/search?q=game&c=apps` in a browser with the
   network panel filtered to `batchexecute` and scroll to the bottom of the
   results.
2. Note the `rpcids` of any request that returns app items. As of July 2026 only
   `teXCtc` fires and it returns related-search chips, not apps, so `teXCtc` is
   the first suspect for a revived pagination RPC.
3. Replay that request to map the item shape, then update
   `SECTIONS_MAPPING.token`, the cluster body builder, and `searchPageItemSpecs`
   together.
4. Only after the continuation parses live, raise the search count assertions
   above 30.

Never satisfy a tripwire by weakening it: thresholds fall under hard rule 11,
so the fix is always a re-port of the contract, never a threshold tweak.

## Coverage gate recalibration

The live suites gate optional fields (`score`, `scoreText`, `summary`,
`currency`, review `text`, `userImage`) through `expectFieldCoverage`, so a
drifted path that stops finding its value fails the daily run with a message
naming the starved field. When a coverage gate fails, first run
`pnpm coverage:live` and read the field's measured ratio:

- **A single field at ~0.0** means a moved path. Fix the matching
  `src/features/<name>/specs.ts` per the steps above and refresh the fixtures
  with `pnpm fixtures:update`. A ratio stuck near the first page's share of the
  result set means only the continuation shape broke, so start at
  `src/core/clusterItem.ts`.
- **A field slightly under its gate across anchors** means catalog drift, not a
  broken path. Lower that field's gate to measured-minus-0.3 in a dedicated
  commit whose body quotes the `coverage:live` report output.

Never delete a gate to green a run (hard rule 11): a gate that no longer holds
is recalibrated from the report data or its contract is re-ported, never
removed.
