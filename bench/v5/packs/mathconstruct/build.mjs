import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const packDir = dirname(fileURLToPath(import.meta.url));
export const defaultSource = String.raw`C:\Users\MiPC\AppData\Local\Temp\opencode\math-benchmarks-20261117\mathconstruct`;
export const suffix = 'Give a complete construction/proof as requested. Put the final answer on its own last line in the form: FINAL: <answer>.';
const python = process.env.MATHCONSTRUCT_PYTHON || 'python';
const sourceRoot = () => resolve(process.env.MATHCONSTRUCT_SOURCE || defaultSource);
const json = value => JSON.stringify(value, null, 2) + '\n';
const hash = value => createHash('sha256').update(value).digest('hex');

// This worker parses source as data. No eval, exec, imports of benchmark modules,
// solution generation, or checker execution occurs during extraction.
const extractor = String.raw`
import ast, json, pathlib, sys, math, operator, string, re, hashlib
root = pathlib.Path(sys.argv[1])
base = root / "src/math_construct/problems"
hashes = {}
def tree(path):
    raw = path.read_bytes()
    hashes[path.relative_to(root).as_posix()] = hashlib.sha256(raw).hexdigest()
    return ast.parse(raw.decode("utf-8"), filename=str(path))
def assignments(nodes):
    return {t.id: n.value for n in nodes if isinstance(n, ast.Assign)
            for t in n.targets if isinstance(t, ast.Name)}
templates = ast.literal_eval(assignments(tree(base / "templates.py").body)["TEMPLATES"])
format_nodes = assignments(tree(root / "src/math_construct/templates.py").body)
tags_class = next(n for n in tree(base / "problem.py").body if isinstance(n, ast.ClassDef) and n.name == "Tag")
tags = {k: ast.literal_eval(v) for k,v in assignments(tags_class.body).items()}
tree(root / "src/math_construct/utils.py")
parsing = root / "src/math_construct/parsing.py"
hashes[parsing.relative_to(root).as_posix()] = hashlib.sha256(parsing.read_bytes()).hexdigest()
readme = (root / "README.md").read_bytes()
hashes["README.md"] = hashlib.sha256(readme).hexdigest()
ops = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
       ast.Div: operator.truediv, ast.FloorDiv: operator.floordiv,
       ast.Mod: operator.mod, ast.Pow: operator.pow}
class Unresolved(Exception): pass
def value(n, env, attrs, path):
    if isinstance(n, ast.Constant): return n.value
    if isinstance(n, ast.Name):
        if n.id in env:
            v = env[n.id]
            return value(v, env, attrs, path) if isinstance(v, ast.AST) else v
        raise Unresolved("unknown name " + n.id)
    if isinstance(n, (ast.List, ast.Tuple)):
        return [value(x, env, attrs, path) for x in n.elts]
    if isinstance(n, ast.Dict):
        return {value(k, env, attrs, path): value(v, env, attrs, path) for k,v in zip(n.keys,n.values)}
    if isinstance(n, ast.Subscript):
        return value(n.value,env,attrs,path)[value(n.slice,env,attrs,path)]
    if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name):
        if n.value.id == "self" and n.attr in attrs: return attrs[n.attr]
        if n.value.id == "Tag": return tags[n.attr]
    if isinstance(n, ast.UnaryOp) and isinstance(n.op, (ast.USub,ast.UAdd)):
        x = value(n.operand,env,attrs,path)
        return -x if isinstance(n.op,ast.USub) else x
    if isinstance(n, ast.BinOp) and type(n.op) in ops:
        a,b = value(n.left,env,attrs,path),value(n.right,env,attrs,path)
        if isinstance(n.op,ast.Pow) and abs(b)>10000: raise Unresolved("exponent bound")
        return ops[type(n.op)](a,b)
    if isinstance(n,ast.Compare) and len(n.ops)==1:
        a,b=value(n.left,env,attrs,path),value(n.comparators[0],env,attrs,path)
        comparisons={ast.Eq:operator.eq,ast.NotEq:operator.ne,ast.Lt:operator.lt,ast.LtE:operator.le,ast.Gt:operator.gt,ast.GtE:operator.ge}
        if type(n.ops[0]) in comparisons: return comparisons[type(n.ops[0])](a,b)
    if isinstance(n,ast.Call):
        label = ast.unparse(n.func)
        if label == "Problem.get_name" and len(n.args)==1 and ast.unparse(n.args[0])=="__file__":
            return path.parent.name.replace("_","-")+"-"+path.stem.replace("_","-").replace("problem-","")
        if label == "dict" and not n.args and not n.keywords: return {}
        if label in ("int","float","str","len","math.ceil") and len(n.args)==1 and not n.keywords:
            return {"int":int,"float":float,"str":str,"len":len,"math.ceil":math.ceil}[label](value(n.args[0],env,attrs,path))
        if label in ("get_list_template","get_matrix_template","get_integer_template","get_fraction_template"):
            name = label[4:-9].upper()+"_FORMATTING_TEMPLATE"
            text = value(format_nodes[name],env,attrs,path)
            extra = value(n.args[0],env,attrs,path) if n.args else None
            return text + ("\n"+extra if extra is not None else "")
        if isinstance(n.func,ast.Attribute) and n.func.attr=="replace" and len(n.args)==2:
            text=value(n.func.value,env,attrs,path)
            if isinstance(text,str): return text.replace(*(value(x,env,attrs,path) for x in n.args))
        if isinstance(n.func,ast.Attribute) and n.func.attr=="format":
            text = value(n.func.value,env,attrs,path)
            if not isinstance(text,str): raise Unresolved("format receiver")
            # Only evaluate fields actually used; upstream sometimes supplies unused
            # solution-derived or drawing arguments.
            fields = {f for _,f,_,_ in string.Formatter().parse(text) if f is not None}
            if any(not re.fullmatch(r"[A-Za-z_]\w*",f) for f in fields): raise Unresolved("non-name format field")
            kwargs = {k.arg:value(k.value,env,attrs,path) for k in n.keywords if k.arg in fields}
            return text.format(**kwargs)
    raise Unresolved("unsupported expression: " + ast.unparse(n))

def render_steps(nodes,env,attrs,path):
    for n in nodes:
        if isinstance(n,ast.Assign) and all(isinstance(x,ast.Name) for x in n.targets):
            v=value(n.value,env,attrs,path)
            for x in n.targets: env[x.id]=v
        elif isinstance(n,ast.Return):
            return value(n.value,env,attrs,path)
        elif isinstance(n,ast.If):
            branch=n.body if value(n.test,env,attrs,path) else n.orelse
            result=render_steps(branch,env,attrs,path)
            if result is not None: return result
        else: raise Unresolved("nontrivial get_problem requires manual parameter resolution")

rows = []
for path in sorted(base.rglob("*.py")):
    rel = path.relative_to(base)
    if "backups" in rel.parts or path.name=="__init__.py": continue
    if path.parent==base: continue
    t = tree(path)
    classes = []
    for cls in t.body:
        if not isinstance(cls,ast.ClassDef): continue
        config = assignments(cls.body).get("config")
        if isinstance(config,ast.Call) and ast.unparse(config.func)=="ProblemConfig": classes.append((cls,config))
    for cls,config in classes:
        fields = {k.arg:k.value for k in config.keywords}
        env = dict(format_nodes, **assignments(t.body))
        env["TEMPLATES"] = templates
        get = lambda key: value(fields[key],env,{},path)
        name, statement = get("name"), get("statement")
        params = get("parameters")
        errors = []
        try: original = get("original_parameters") if "original_parameters" in fields else None
        except (Unresolved,KeyError,ValueError) as e:
            original = None
            errors.append(str(e))
        attrs = dict(original or {})
        local = dict(env, **attrs)
        methods = {n.name:n for n in cls.body if isinstance(n,ast.FunctionDef)}
        # Resolve only straight-line, allowlisted initializer arithmetic. Never call
        # get_solution, check, generate, or any upstream function.
        if "__init__" in methods:
            for n in methods["__init__"].body:
                if not isinstance(n,ast.Assign): continue
                try: v = value(n.value,local,attrs,path)
                except (Unresolved,KeyError,ValueError,TypeError): continue
                for target in n.targets:
                    if isinstance(target,ast.Attribute) and ast.unparse(target.value)=="self": attrs[target.attr]=v
                    elif isinstance(target,ast.Name): local[target.id]=v
        rendered = None
        if original is not None and all(p in attrs for p in params):
            method = methods.get("get_problem")
            try:
                if method is None:
                    rendered = statement.format(**original)
                elif len(method.body)==1 and isinstance(method.body[0],ast.Return):
                    rendered = value(method.body[0].value,local,attrs,path)
                else:
                    # Formatting-only assignment/return sequences, not arbitrary control flow.
                    rendered = render_steps(method.body,local,attrs,path)
            except (Unresolved,KeyError,ValueError,TypeError) as e: errors.append(str(e))
        else: errors.append("original_parameters absent or incomplete")
        needs = rendered is None
        if needs:
            # Keep a faithful template rather than inventing parameters.
            rendered = statement
        if re.search(r"https?://",rendered): raise ValueError("URL in statement: "+name)
        if re.search(r"original_solution|def (check|verify)\(",rendered): raise ValueError("code leakage: "+name)
        for node in ast.walk(t):
            if isinstance(node,ast.FunctionDef) and node.name in ("get_solution","check","verify"):
                body=ast.unparse(node)
                if body in rendered: raise ValueError("function body in statement: "+name)
        # A literal answer occurring in a statement is conservatively pilot-ineligible.
        # No solution-generating expression is evaluated.
        literal_overlap = False
        try:
            sol = ast.literal_eval(fields["original_solution"])
            forms = [str(sol),json.dumps(sol,ensure_ascii=False)]
            literal_overlap = any(s and s in rendered for s in forms)
        except (ValueError,TypeError,KeyError): pass
        checker = next((m for m in ("check","verify") if m in methods),None)
        if checker is None: raise ValueError("No validator for "+name)
        answer_format = get("formatting_instructions")
        module = ".".join(path.relative_to(root/"src").with_suffix("").parts)
        rows.append(dict(id=name,statement=rendered,template=statement,parameters=params,
            original_parameters=original,tags=get("tags"),source=get("source"),
            answer_format=answer_format,source_file=path.relative_to(root).as_posix(),
            module=module,class_name=cls.name,method=checker,needs_parameters=needs,
            resolution_errors=errors,literal_solution_overlap=literal_overlap,
            has_original_solution="original_solution" in fields))
print(json.dumps(dict(rows=sorted(rows,key=lambda r:r["id"]),source_hashes=dict(sorted(hashes.items()))),ensure_ascii=True))
`;

export function extract(source = sourceRoot()) {
  const result = spawnSync(python, ['-B', '-c', extractor, source], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' },
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr);
  return JSON.parse(result.stdout);
}

// Equal category round-robin; within each category, prefer coverage of as-yet
// unrepresented secondary tags, then lexical id. A task is selected only once.
export function choosePilot(tasks) {
  const categories = ['Algebra', 'Combinatorics', 'Geometry', 'Number Theory', 'Puzzle'];
  const eligible = tasks.filter(t => !t.metadata.needs_parameters && t.metadata.pilot_eligible);
  const selected = [], counts = new Map();
  while (selected.length < 20) {
    let progress = false;
    for (const category of categories) {
      const candidates = eligible.filter(t => t.metadata.tags.includes(category) && !selected.includes(t));
      const coverage = t => t.metadata.tags.reduce((n, tag) => n + 1 / (1 + (counts.get(tag) || 0)), 0);
      candidates.sort((a, b) => coverage(b) - coverage(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (!candidates.length) continue;
      const next = candidates[0];
      selected.push(next);
      for (const tag of next.metadata.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
      progress = true;
      if (selected.length === 20) break;
    }
    if (!progress) throw new Error('Fewer than 20 eligible tasks');
  }
  return selected.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function buildPack({ source = sourceRoot(), previous = {} } = {}) {
  const extracted = extract(source);
  const sourceHash = hash(json(extracted.source_hashes));
  const tasks = extracted.rows.map(row => {
    const originalComplete = row.original_parameters !== null
      && row.parameters.every(p => Object.hasOwn(row.original_parameters, p));
    const eligible = originalComplete && !row.needs_parameters && !row.literal_solution_overlap
      && !/\b(example|instance|e\.g\.)\b/i.test(row.statement);
    return {
      schema: 'math-bench-task/v1', benchmark: 'mathconstruct', id: row.id,
      prompt: row.statement.trim() + '\n\n' + suffix, answer: null,
      grading: {
        type: 'validator', validator: `${row.module}:${row.class_name}.${row.method}`,
        answer_format: 'Last line: FINAL: <answer>. The answer payload should use the upstream format: '
          + (row.answer_format || 'A construction in the representation requested by the statement.'),
      },
      metadata: {
        source: row.source, tags: row.tags, parameters: row.parameters,
        original_parameters: row.original_parameters,
        license: 'MIT (code); source rights apply',
        note: 'AST-only extraction from the current checkout; no solution or validator executed. '
          + 'Only the statement is placed in the prompt. Upstream checkers test constructions, not the full prose proof.'
          + (row.needs_parameters ? ' Unresolved statement retained as a template; excluded from pilot.' : ''),
        source_file: row.source_file, source_sha256: extracted.source_hashes[row.source_file],
        source_bundle_sha256: sourceHash,
        needs_parameters: row.needs_parameters, resolution_errors: row.resolution_errors,
        pilot_eligible: eligible,
        pilot_exclusion: row.needs_parameters ? 'unresolved statement parameters'
          : !originalComplete ? 'config parameter list includes a derived parameter absent from original_parameters'
          : row.literal_solution_overlap ? 'literal original answer overlaps statement'
          : !eligible ? 'conservative exclusion of example-bearing statement' : null,
      },
    };
  });
  if (new Set(tasks.map(t => t.id)).size !== tasks.length) throw new Error('Duplicate task ids');
  const pilot = choosePilot(tasks);
  const validators = Object.fromEntries(extracted.rows.map(row => {
    const entry = {
      entry_point: `${row.module}:${row.class_name}.${row.method}`,
      module: row.module, class_name: row.class_name, method: row.method,
      source_file: row.source_file, source_sha256: extracted.source_hashes[row.source_file],
      source_bundle_sha256: sourceHash,
      source_hashes: Object.fromEntries(Object.entries(extracted.source_hashes).filter(([path]) =>
        path === row.source_file || ['README.md', 'src/math_construct/problems/templates.py',
          'src/math_construct/problems/problem.py', 'src/math_construct/templates.py',
          'src/math_construct/utils.py', 'src/math_construct/parsing.py'].includes(path))),
      command: ['node', 'build.mjs', '--validate', row.id, '--answer', '<response.txt>'],
      cwd: 'bench/v5/packs/mathconstruct',
      source_environment: 'MATHCONSTRUCT_SOURCE', timeout_seconds: 60,
      answer_adapter: 'Read last nonempty FINAL: line; wrap unboxed payload in \\boxed{...}; upstream class.parse then instance.check. Never eval model output.',
      executed: false, verified: false, runs: [],
      smoke: { status: 'not_run', reason: 'Optional original-solution smoke not requested; use node build.mjs --smoke.' },
    };
    const old = previous[row.id];
    if (old?.source_bundle_sha256 === sourceHash) {
      entry.runs = old.runs || [];
      entry.executed = entry.runs.some(r => r.checker_executed === true);
      entry.verified = entry.runs.some(r => r.status === 'accepted' && r.checker_executed === true);
      entry.smoke = old.smoke || entry.smoke;
    }
    return [row.id, entry];
  }));
  const baselines = {
    schema: 'math-bench-baselines/v1', benchmark: 'mathconstruct',
    model: 'opencode-go/deepseek-v4.1-flash', external: [],
    note: 'No published score for this exact model/version was found; use the paired plugin-off arm.',
  };
  return { tasks, pilot, validators, baselines };
}

// Optional checker process. Synthetic package namespaces bypass the upstream
// eager-import-all problems/__init__.py. Only the selected trusted module loads.
// This is not a security sandbox; never use an untrusted source checkout.
const validatorWorker = String.raw`
import sys, json, pathlib, types, importlib, contextlib, io
root=pathlib.Path(sys.argv[1]); entry=json.loads(sys.argv[2]); mode=sys.argv[3]
for name,rel in [("math_construct","src/math_construct"),("math_construct.problems","src/math_construct/problems")]:
    pkg=types.ModuleType(name); pkg.__path__=[str(root/rel)]; sys.modules[name]=pkg
# No network or filesystem writes are permitted by this runner.
def audit(event,args):
    if event.startswith("socket.") or event in ("subprocess.Popen","os.system","os.mkdir","os.remove","os.rename","os.rmdir"):
        raise RuntimeError("blocked side effect: "+event)
    if event=="open":
        mode=args[1]; flags=args[2]
        if (isinstance(mode,str) and any(c in mode for c in "wax+")) or (isinstance(flags,int) and flags & (1|2|64|512|1024)):
            raise RuntimeError("blocked file write")
sys.addaudithook(audit)
checked=False
try:
    # Discard import/parser/checker output: it may contain a reference solution.
    with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
        module=importlib.import_module(entry["module"])
        cls=getattr(module,entry["class_name"]); instance=cls.get_original()
        if mode=="original":
            answer=cls.config.original_solution
        else:
            text=sys.stdin.read()
            lines=[x.strip() for x in text.splitlines() if x.strip()]
            if not lines or not lines[-1].startswith("FINAL:"): raise ValueError("missing FINAL last line")
            payload=lines[-1][6:].strip()
            if not payload: raise ValueError("empty FINAL answer")
            if not payload.startswith(r"\boxed{"): payload=r"\boxed{"+payload+"}"
            answer=cls.parse(payload)
        checked=True
        result=getattr(instance,entry["method"])(answer)
    accepted=result[0] if isinstance(result,tuple) else result
    if type(accepted) is not bool: raise TypeError("checker did not return a boolean")
    print(json.dumps(dict(status="accepted" if accepted else "rejected",checker_executed=True)))
except Exception as e:
    print(json.dumps(dict(status="error",checker_executed=checked,error_type=type(e).__name__)))
`;

function runValidator(entry, mode, answer = '') {
  const result = spawnSync(python, ['-B', '-c', validatorWorker, sourceRoot(), JSON.stringify(entry), mode], {
    input: answer, encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
    cwd: packDir, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' },
  });
  if (result.error || result.status !== 0) {
    return { status: result.error?.code === 'ETIMEDOUT' ? 'timeout' : 'error',
      checker_executed: false, error: result.error?.code || `process exit ${result.status}` };
  }
  return JSON.parse(result.stdout);
}

function smoke(pack) {
  const uv = spawnSync('uv', ['--version'], { encoding: 'utf8', timeout: 10_000 });
  const probe = spawnSync(python, ['-B', '-c', 'import importlib.util,json; print(json.dumps([x for x in ["pydantic","numpy","sympy","loguru","scipy","antlr4"] if importlib.util.find_spec(x) is None]))'],
    { encoding: 'utf8', timeout: 10_000 });
  const reasons = [];
  if (uv.error || uv.status !== 0) reasons.push(`uv unavailable: ${uv.error?.code || `exit ${uv.status}`}`);
  if (probe.error || probe.status !== 0) reasons.push('dependency probe failed');
  else {
    const missing = JSON.parse(probe.stdout);
    if (missing.length) reasons.push(`Python checker dependencies missing: ${missing.join(', ')}`);
  }
  for (const task of pack.pilot.slice(0, 2)) {
    const entry = pack.validators[task.id];
    if (reasons.length) {
      entry.smoke = { status: 'not_run', reason: reasons.join('; ') };
    } else {
      const receipt = { kind: 'original_solution_smoke', ...runValidator(entry, 'original'),
        source_bundle_sha256: entry.source_bundle_sha256 };
      entry.runs.push(receipt);
      entry.smoke = { status: receipt.status, run_index: entry.runs.length - 1 };
      entry.executed = entry.runs.some(r => r.checker_executed);
      entry.verified = entry.runs.some(r => r.status === 'accepted' && r.checker_executed);
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const previousPath = join(packDir, 'validators.json');
  const previous = existsSync(previousPath) ? JSON.parse(readFileSync(previousPath, 'utf8')) : {};
  const pack = buildPack({ previous });
  if (args.includes('--validate')) {
    const id = args[args.indexOf('--validate') + 1];
    const answerIndex = args.indexOf('--answer');
    if (!pack.validators[id] || answerIndex < 0 || !args[answerIndex + 1]) throw new Error('Expected --validate <id> --answer <response.txt>');
    const entry = pack.validators[id];
    const run = { kind: 'candidate', ...runValidator(entry, 'candidate', readFileSync(resolve(args[answerIndex + 1]), 'utf8')),
      source_bundle_sha256: entry.source_bundle_sha256 };
    entry.runs.push(run);
    entry.executed = entry.runs.some(r => r.checker_executed);
    entry.verified = entry.runs.some(r => r.status === 'accepted' && r.checker_executed);
    writeFileSync(previousPath, json(pack.validators));
    console.log(json(run));
    process.exitCode = run.status === 'accepted' ? 0 : 1;
    return;
  }
  if (args.includes('--smoke')) smoke(pack);
  for (const [name, value] of Object.entries(pack)) writeFileSync(join(packDir, name + '.json'), json(value));
  console.log(json({
    problem_count: pack.tasks.length, pilot_ids: pack.pilot.map(t => t.id),
    unresolved: pack.tasks.filter(t => t.metadata.needs_parameters).map(t => t.id),
    tags: tagDistribution(pack.tasks), pilot_tags: tagDistribution(pack.pilot),
    smoke: Object.fromEntries(pack.pilot.slice(0, 2).map(t => [t.id, pack.validators[t.id].smoke])),
    sha256: { tasks: hash(json(pack.tasks)), pilot: hash(json(pack.pilot)) },
  }));
}

export function tagDistribution(tasks) {
  const counts = {};
  for (const task of tasks) for (const tag of task.metadata.tags) counts[tag] = (counts[tag] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a < b ? -1 : 1));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
