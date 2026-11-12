import { EMAIL_RE, EMPLOYEE_ID_RE, normalizeEmail, normalizeEmployeeId, normalizeName, teamLabel } from '../normalize';

export type ImportFormat = 'team' | 'participant';
export type Mapping = Record<string, string | undefined>;

export const TEAM_FORMAT_FIELDS = [
  'team_number', 'team_name',
  ...[1, 2, 3, 4].flatMap((n) => [`p${n}_name`, `p${n}_employee_id`, `p${n}_email`]),
] as const;
export const PARTICIPANT_FORMAT_FIELDS = ['team_number', 'team_name', 'name', 'employee_id', 'email'] as const;

export const fieldsFor = (f: ImportFormat): readonly string[] => (f === 'team' ? TEAM_FORMAT_FIELDS : PARTICIPANT_FORMAT_FIELDS);

const SYNONYMS: Record<string, string[]> = {
  team_number: ['teamnumber', 'teamno', 'team', 'teamnum', 'teamid', 'slotteam', 'number'],
  team_name: ['teamname', 'nameofteam', 'teamtitle'],
  name: ['name', 'participantname', 'participant', 'membername', 'fullname', 'employeename'],
  employee_id: ['employeeid', 'empid', 'empno', 'employeeno', 'employeenumber', 'staffid', 'id'],
  email: ['email', 'emailid', 'corporateemail', 'workemail', 'emailaddress', 'mail'],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Best-effort automatic column mapping; the admin confirms it in the UI. */
export function suggestMapping(headers: string[], format: ImportFormat): Mapping {
  const byNorm = new Map(headers.map((h) => [norm(h), h]));
  const pick = (cands: string[]) => cands.map((c) => byNorm.get(c)).find(Boolean);
  const m: Mapping = {};
  m.team_number = pick(SYNONYMS.team_number);
  m.team_name = pick(SYNONYMS.team_name);
  if (format === 'participant') {
    m.name = pick(SYNONYMS.name.filter((s) => s !== 'teamname'));
    m.employee_id = pick(SYNONYMS.employee_id);
    m.email = pick(SYNONYMS.email);
  } else {
    for (const n of [1, 2, 3, 4]) {
      const pre = [`p${n}`, `participant${n}`, `member${n}`];
      m[`p${n}_name`] = pick(pre.flatMap((p) => [`${p}name`, p, `${p}fullname`]));
      m[`p${n}_employee_id`] = pick(pre.flatMap((p) => [`${p}employeeid`, `${p}empid`, `${p}id`, `${p}empno`]));
      m[`p${n}_email`] = pick(pre.flatMap((p) => [`${p}email`, `${p}emailid`, `${p}mail`]));
    }
  }
  return Object.fromEntries(Object.entries(m).filter(([, v]) => v));
}

export interface ImportContext {
  teams: { id: string; team_number: number; name: string | null; status: string; occupied: number }[];
  employee_ids: string[];
  emails: string[];
  frozen: boolean;
}

export interface PlanMember { name: string; employee_id: string; email: string | null }
export interface PlanTeam {
  team_id: string;
  team_number: number;
  team_name: string;
  members: PlanMember[];
  source_rows: number[];
  assignment: 'explicit' | 'auto';
}
export interface Issue { rows: number[]; message: string }
export interface ImportPlan {
  teams: PlanTeam[];
  errors: Issue[];
  warnings: Issue[];
  summary: { rows: number; teams: number; participants: number; by_size: Record<string, number> };
}

interface Group { key: string; rows: number[]; team_number: number | null; team_name: string; members: (PlanMember & { row: number })[] }

/**
 * Builds a deterministic import plan. Rules:
 *  - Members fill P1..Pn strictly in source order.
 *  - A pre-generated team is targeted by its number when given, otherwise the next
 *    vacant team in ascending number order.
 *  - Occupied teams are NEVER overwritten (error), duplicates are reported, nothing is silent.
 *  - The database re-validates everything inside the commit transaction.
 */
export function buildPlan(format: ImportFormat, rows: Record<string, string>[], mapping: Mapping, ctx: ImportContext): ImportPlan {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const get = (r: Record<string, string>, f: string) => (mapping[f] ? String(r[mapping[f]!] ?? '').trim() : '');

  if (format === 'participant' && (!mapping.name || !mapping.employee_id)) {
    errors.push({ rows: [], message: 'Map the participant name and employee ID columns' });
  }
  if (format === 'participant' && !mapping.team_number && !mapping.team_name) {
    errors.push({ rows: [], message: 'Map a team number or team name column so participants can be grouped' });
  }
  if (format === 'team' && (!mapping.p1_name || !mapping.p1_employee_id || !mapping.p2_name || !mapping.p2_employee_id)) {
    errors.push({ rows: [], message: 'Map at least P1 and P2 name + employee ID columns' });
  }
  if (errors.length) return { teams: [], errors, warnings, summary: { rows: rows.length, teams: 0, participants: 0, by_size: {} } };

  const parseNumber = (raw: string, row: number): number | null => {
    if (!raw) return null;
    const digits = raw.replace(/^\s*team\s*/i, '').replace(/^#/, '').trim();
    if (!/^\d{1,4}$/.test(digits) || Number(digits) < 1) {
      errors.push({ rows: [row], message: `Invalid team number "${raw}"` });
      return null;
    }
    return Number(digits);
  };

  // 1. group rows into teams
  const groups: Group[] = [];
  const byKey = new Map<string, Group>();
  rows.forEach((r, i) => {
    const row = i + 2; // spreadsheet row number (header is row 1)
    const team_number = parseNumber(get(r, 'team_number'), row);
    const team_name = normalizeName(get(r, 'team_name'));
    if (format === 'team') {
      const members: (PlanMember & { row: number })[] = [];
      for (const n of [1, 2, 3, 4]) {
        const name = normalizeName(get(r, `p${n}_name`));
        const emp = normalizeEmployeeId(get(r, `p${n}_employee_id`));
        const email = normalizeEmail(get(r, `p${n}_email`));
        if (name || emp || email) members.push({ name, employee_id: emp, email, row });
      }
      groups.push({ key: `row:${row}`, rows: [row], team_number, team_name, members });
    } else {
      const key = team_number != null ? `n:${team_number}` : team_name ? `t:${team_name.toLowerCase()}` : '';
      if (!key) {
        errors.push({ rows: [row], message: 'Row has neither a team number nor a team name' });
        return;
      }
      let g = byKey.get(key);
      if (!g) {
        g = { key, rows: [], team_number, team_name, members: [] };
        byKey.set(key, g);
        groups.push(g);
      } else if (team_name && g.team_name && team_name.toLowerCase() !== g.team_name.toLowerCase()) {
        errors.push({ rows: [row], message: `Team ${team_number} has conflicting names "${g.team_name}" and "${team_name}"` });
      }
      if (!g.team_name && team_name) g.team_name = team_name;
      g.rows.push(row);
      const name = normalizeName(get(r, 'name'));
      const emp = normalizeEmployeeId(get(r, 'employee_id'));
      g.members.push({ name, employee_id: emp, email: normalizeEmail(get(r, 'email')), row });
    }
  });

  // 2. validate members + duplicates
  const existingEmp = new Set(ctx.employee_ids.map(normalizeEmployeeId));
  const existingEmail = new Set(ctx.emails.map((e) => e.toLowerCase()));
  const seenEmp = new Map<string, number>();
  const seenEmail = new Map<string, number>();
  for (const g of groups) {
    if (g.members.length < 2 || g.members.length > 4) {
      errors.push({ rows: g.rows, message: `${g.team_name || g.key}: a team needs 2–4 participants (found ${g.members.length})` });
    }
    for (const m of g.members) {
      if (!m.name) errors.push({ rows: [m.row], message: 'Participant name is missing' });
      if (!EMPLOYEE_ID_RE.test(m.employee_id)) errors.push({ rows: [m.row], message: `Invalid employee ID "${m.employee_id}"` });
      if (m.email && !EMAIL_RE.test(m.email)) errors.push({ rows: [m.row], message: `Invalid email "${m.email}"` });
      if (m.employee_id) {
        if (existingEmp.has(m.employee_id)) errors.push({ rows: [m.row], message: `Employee ID ${m.employee_id} is already registered in this event` });
        if (seenEmp.has(m.employee_id)) errors.push({ rows: [seenEmp.get(m.employee_id)!, m.row], message: `Duplicate employee ID ${m.employee_id} in file` });
        else seenEmp.set(m.employee_id, m.row);
      }
      if (m.email) {
        if (existingEmail.has(m.email)) errors.push({ rows: [m.row], message: `Email ${m.email} is already registered in this event` });
        if (seenEmail.has(m.email)) errors.push({ rows: [seenEmail.get(m.email)!, m.row], message: `Duplicate email ${m.email} in file` });
        else seenEmail.set(m.email, m.row);
      }
    }
  }

  // 3. resolve target teams (explicit numbers first, then auto-allocate vacant teams)
  const byNumber = new Map(ctx.teams.map((t) => [t.team_number, t]));
  const claimed = new Set<number>();
  const target = new Map<Group, { id: string; team_number: number; assignment: 'explicit' | 'auto' }>();
  for (const g of groups.filter((x) => x.team_number != null)) {
    const n = g.team_number!;
    const t = byNumber.get(n);
    if (!t) {
      errors.push({ rows: g.rows, message: `${teamLabel(n)} has not been generated — extend team capacity first` });
      continue;
    }
    if (claimed.has(n)) {
      errors.push({ rows: g.rows, message: `${teamLabel(n)} is targeted by more than one team in the file` });
      continue;
    }
    claimed.add(n);
    if (t.occupied > 0 || t.status === 'withdrawn') {
      errors.push({ rows: g.rows, message: `${teamLabel(n)} already has participants — it will not be overwritten` });
      continue;
    }
    target.set(g, { id: t.id, team_number: n, assignment: 'explicit' });
  }
  const freeTeams = ctx.teams
    .filter((t) => t.occupied === 0 && t.status === 'unregistered' && !claimed.has(t.team_number))
    .sort((a, b) => a.team_number - b.team_number);
  const autoGroups = groups.filter((x) => x.team_number == null);
  if (autoGroups.length > freeTeams.length) {
    errors.push({
      rows: [],
      message: `${autoGroups.length} teams need a slot but only ${freeTeams.length} vacant pre-generated teams remain — generate ${autoGroups.length - freeTeams.length} more`,
    });
  }
  autoGroups.forEach((g, i) => {
    const t = freeTeams[i];
    if (t) target.set(g, { id: t.id, team_number: t.team_number, assignment: 'auto' });
  });

  // 4. team names: unique within file and against other existing teams
  const existingNames = new Map(ctx.teams.filter((t) => t.name).map((t) => [t.name!.toLowerCase(), t.team_number]));
  const seenNames = new Map<string, Group>();
  const teams: PlanTeam[] = [];
  for (const g of groups) {
    const tgt = target.get(g);
    const name = g.team_name || (tgt ? teamLabel(tgt.team_number) : '');
    if (g.team_name) {
      if (g.team_name.length < 2 || g.team_name.length > 60) errors.push({ rows: g.rows, message: `Team name "${g.team_name}" must be 2–60 characters` });
      const lower = g.team_name.toLowerCase();
      const prev = seenNames.get(lower);
      if (prev && prev !== g) errors.push({ rows: [...prev.rows, ...g.rows], message: `Team name "${g.team_name}" appears for two different teams` });
      seenNames.set(lower, g);
      const owner = existingNames.get(lower);
      if (owner != null && owner !== tgt?.team_number) errors.push({ rows: g.rows, message: `Team name "${g.team_name}" is already used by ${teamLabel(owner)}` });
    } else {
      warnings.push({ rows: g.rows, message: `No team name — will default to "${name || 'Team ###'}"` });
    }
    if (tgt) {
      teams.push({
        team_id: tgt.id,
        team_number: tgt.team_number,
        team_name: name,
        members: g.members.map(({ name: n, employee_id, email }) => ({ name: n, employee_id, email })),
        source_rows: g.rows,
        assignment: tgt.assignment,
      });
    }
  }
  if (ctx.frozen) warnings.push({ rows: [], message: 'Participant changes are frozen — committing requires a privileged reason' });

  const by_size: Record<string, number> = {};
  for (const t of teams) by_size[String(t.members.length)] = (by_size[String(t.members.length)] ?? 0) + 1;
  teams.sort((a, b) => a.team_number - b.team_number);
  return {
    teams,
    errors,
    warnings,
    summary: { rows: rows.length, teams: teams.length, participants: teams.reduce((s, t) => s + t.members.length, 0), by_size },
  };
}
