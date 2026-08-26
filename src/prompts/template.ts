import type { Database, Statement } from 'better-sqlite3';

export interface PromptTemplate {
  id: string;
  name: string;
  version: number;
  body: string;
  variables: string[];
  modelHints: string[];
  createdAt: number;
  updatedAt: number;
  isLatest: boolean;
}

interface PromptTemplateRow {
  id: string;
  name: string;
  version: number;
  body: string;
  variables: string;
  model_hints: string;
  created_at: number;
  updated_at: number;
  is_latest: number;
}

export interface PromptVariableSpec {
  name: string;
  required: boolean;
  defaultValue?: string;
}

/**
 * Parse a `{{var}}` template body, return the set of referenced variable names.
 * Variable names follow [A-Za-z_][A-Za-z0-9_]*.
 */
export function extractVariables(body: string): string[] {
  const out = new Set<string>();
  const re = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.add(m[1]!);
  return Array.from(out);
}

export class PromptTemplateRepo {
  private readonly putStmt: Statement;
  private readonly getStmt: Statement;
  private readonly getByNameStmt: Statement;
  private readonly listLatestStmt: Statement;
  private readonly listVersionsStmt: Statement;
  private readonly setLatestStmt: Statement;
  private readonly unsetLatestStmt: Statement;
  private readonly delStmt: Statement;

  constructor(private readonly db: Database) {
    this.putStmt = db.prepare(`
      INSERT INTO prompt_templates (id, name, version, body, variables, model_hints, created_at, updated_at, is_latest)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        body = excluded.body,
        variables = excluded.variables,
        model_hints = excluded.model_hints,
        updated_at = excluded.updated_at
    `);
    this.getStmt = db.prepare(`SELECT * FROM prompt_templates WHERE id = ?`);
    this.getByNameStmt = db.prepare(`SELECT * FROM prompt_templates WHERE name = ? AND is_latest = 1 LIMIT 1`);
    this.listLatestStmt = db.prepare(`
      SELECT * FROM prompt_templates WHERE is_latest = 1 ORDER BY name ASC
    `);
    this.listVersionsStmt = db.prepare(`SELECT * FROM prompt_templates WHERE name = ? ORDER BY version DESC`);
    this.setLatestStmt = db.prepare(`UPDATE prompt_templates SET is_latest = 1 WHERE id = ?`);
    this.unsetLatestStmt = db.prepare(`UPDATE prompt_templates SET is_latest = 0 WHERE name = ?`);
    this.delStmt = db.prepare(`DELETE FROM prompt_templates WHERE id = ?`);
  }

  save(t: Omit<PromptTemplate, 'isLatest' | 'variables' | 'modelHints'> & { variables: string[]; modelHints: string[] }): void {
    this.putStmt.run(
      t.id, t.name, t.version, t.body,
      JSON.stringify(t.variables), JSON.stringify(t.modelHints),
      t.createdAt, t.updatedAt, 0,
    );
  }

  publish(id: string): void {
    const row = this.getStmt.get(id) as PromptTemplateRow | undefined;
    if (!row) throw new Error(`prompt template not found: ${id}`);
    this.db.transaction(() => {
      this.unsetLatestStmt.run(row.name);
      this.setLatestStmt.run(id);
    })();
  }

  get(id: string): PromptTemplate | null {
    const row = this.getStmt.get(id) as PromptTemplateRow | undefined;
    return row ? toTemplate(row) : null;
  }

  getLatest(name: string): PromptTemplate | null {
    const row = this.getByNameStmt.get(name) as PromptTemplateRow | undefined;
    return row ? toTemplate(row) : null;
  }

  listLatest(): PromptTemplate[] {
    return (this.listLatestStmt.all() as PromptTemplateRow[]).map(toTemplate);
  }

  listVersions(name: string): PromptTemplate[] {
    return (this.listVersionsStmt.all(name) as PromptTemplateRow[]).map(toTemplate);
  }

  delete(id: string): number {
    return this.delStmt.run(id).changes;
  }
}

function toTemplate(r: PromptTemplateRow): PromptTemplate {
  return {
    id: r.id,
    name: r.name,
    version: r.version,
    body: r.body,
    variables: JSON.parse(r.variables) as string[],
    modelHints: JSON.parse(r.model_hints) as string[],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    isLatest: r.is_latest === 1,
  };
}

export type RenderContext = Record<string, string | number | boolean | object | null>;

export class TemplateRenderer {
  /**
   * Render a template body with the given variables. Unknown variables throw
   * a `TemplateError`. Variables are inserted as text by default; pass
   * `coerce: 'json'` to JSON-encode object values.
   */
  render(body: string, ctx: RenderContext, knownVars: string[] = extractVariables(body)): string {
    const known = new Set(knownVars);
    return body.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (full, name: string) => {
      if (!(name in ctx)) {
        if (known.has(name)) throw new TemplateError(`missing required variable: ${name}`);
        return full;
      }
      const v = ctx[name]!;
      return typeof v === 'string' ? v : JSON.stringify(v);
    });
  }
}

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
  }
}
