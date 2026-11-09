# Deterministic grader contracts

- **Symbolic:** rational-polynomial equivalence, registered denominator classes,
  domain, assumptions and conditions remain exact. Solution sets must be complete.
  If the grading spec has `units`, the answer must contain exactly that value;
  there is no conversion or normalization. If the spec omits `units`, answer
  units remain unconstrained (the original behavior).
- **Numeric:** finite numeric value within the maximum of absolute and relative
  tolerances; exact domain and units; exact set of conditions. Extraction requires
  string domain/units and a string array of conditions, even for dimensionless
  values (use the registered string). Missing units fail, not inferred from logs.
- **Absence:** status and consulted IDs must match; the existing observed-consultation,
  corpus-unavailability or exhaustive-inventory evidence is still required.
  `prose` is a required non-whitespace string for every absence status. It must
  contain `consulted excerpt`, `consulted excerpts`, `excerpt consulted`, or
  `excerpts consulted` (case-insensitive; whitespace collapsed and hyphens/dashes
  normalized to spaces). Unless the spec explicitly sets `exhaustive_inventory`
  to `true`, a conservative phrase denylist rejects entire/whole/full corpus,
  corpus-wide, anywhere/nowhere, does/do not exist (including contractions),
  nonexistent/non-existent, no [such] document/manuscript/paper/result/theorem/proof
  exists, no such items in the corpus, nothing/no matches/no results in the corpus,
  and corpus contains/has no. See the regex in `absence.mjs` for exact forms.
  This is an English heuristic, not human or LLM adjudication: unfamiliar claims
  can evade it, and quoted or negated global phrases can be false positives.
  A scope phrase alone does not establish the truth of arbitrary prose.
- **Explanation/error detection:** only exact-text SHA-256 hashes registered in
  fixture labels are scored against every rubric criterion. A correct unregistered
  paraphrase fails. These scores validate fixtures, not general explanations.
- **Citation:** exact document, locator, supported claim, and affirmative `supported`
  flag. A narrower locator is rejected too; there is no implicit locator permission.
