import { fileURLToPath } from 'node:url';
import { leanVerify } from '../../../.opencode/plugins/math-toolkit/lib/verify.js';
import { runLeanSource } from '../../../.opencode/plugins/math-toolkit/lib/lean.js';
import { sha256, validateNamed } from '../lib.mjs';

const roots = Object.freeze({ math: fileURLToPath(new URL('../../../math/', import.meta.url)) });

// This same normalized string must be used in the typed final answer.
export function normalizeLeanSolution(code) {
  if (typeof code !== 'string') throw new TypeError('code must be Lean source text');
  let source = code.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  while (/^import[\t ]/.test(source)) source = source.replace(/^import[^\n]*(?:\n|$)/, '').trimStart();
  return source.trim() ? source.trim() + '\n' : '';
}

// Fixed key order; array order is significant. No implicit imports or axioms.
export function leanTargetHash({ theorem, expectedType, imports, allowedAxioms }) {
  return sha256({ theorem, expectedType, imports, allowedAxioms });
}

function failureReceipt(error, request, durationMs) {
  return {
    version: 'math-lean-verify/v1',
    execution: {
      status: error?.code === 'ENOENT' ? 'missing-tool' : error?.code === 'ETIMEDOUT' ? 'timeout' : 'error',
      mode: 'docker', exitCode: null, durationMs,
      error: String(error?.message ?? error)
    },
    compilation: { status: 'not-run' },
    target: { theorem: request.theorem, expectedType: request.expectedType, status: 'not-requested' },
    proof: { status: 'unverified', axioms: [], allowedAxioms: request.allowedAxioms, unauthorizedAxioms: [], sorryAx: false },
    checker: { tool: 'lake env lean' },
    note: 'Bridge execution or receipt validation failed; no proof certified. Informal correspondence is not assessed.'
  };
}

function envelope(request, solution, verifier) {
  const body = {
    schema_version: '2.1.0', format: 'math-study-verification/v1',
    simulated: false, issuer: 'restricted-verifier',
    target_sha256: leanTargetHash(request), solution_sha256: sha256(solution),
    policy_sha256: sha256({ allowed_axioms: request.allowedAxioms }),
    verifier,
    provenance: {
      issuance: 'evaluator-controlled', evidence: 'verifier-output',
      source_receipt_sha256: sha256(verifier), independent_kernel_check: false
    },
    correspondence: { status: 'not-assessed', scope: 'fixed-lean-target-only' },
    toolchain: request.toolchain
  };
  return validateNamed('verification-receipt', { ...body, receipt_sha256: sha256(body) });
}

// Evaluator/test dependency injection only. Never take dependencies, roots, or
// receipts from an agent request; the public submission API takes source only.
export function createLeanVerifier({ verifier = leanVerify, runner = runLeanSource } = {}) {
  return async function verifyLeanSubmission({ code, theorem, expectedType, imports, allowedAxioms, toolchain }) {
    if (typeof theorem !== 'string' || !theorem.trim() || typeof expectedType !== 'string' || !expectedType.trim()) {
      throw new TypeError('theorem and expectedType must be nonempty evaluator-supplied strings');
    }
    for (const [name, values] of Object.entries({ imports, allowedAxioms })) {
      if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) throw new TypeError(`${name} must be an explicit evaluator-supplied string array`);
    }
    if (typeof toolchain !== 'string' || !toolchain.trim()) throw new TypeError('toolchain must be a nonempty evaluator-supplied string');
    const request = { theorem, expectedType, imports: [...imports], allowedAxioms: [...allowedAxioms], toolchain };
    const solution = normalizeLeanSolution(code);
    const started = performance.now();
    try {
      // Conservative rejection also covers imports hidden behind comments or
      // nonstandard headers. Only the task's imports may reach the runner.
      if (/\bimport\b/.test(solution)) throw new Error('Submission contains an import outside the removable leading import lines');
      const raw = await verifier(roots, {
        code: solution, theorem, expectedType, imports: [...request.imports],
        allowedAxioms: [...request.allowedAxioms], docker: true
      }, runner);
      const receipt = typeof raw === 'string' ? JSON.parse(raw) : structuredClone(raw);
      // Preserve all schema-valid v1 statuses, including failures. Invalid or
      // absent output is an execution error, never a synthesized success.
      return envelope(request, solution, receipt);
    } catch (error) {
      return envelope(request, solution, failureReceipt(error, request, Math.round(performance.now() - started)));
    }
  };
}

export const verifyLeanSubmission = createLeanVerifier();
