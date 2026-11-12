import { z } from 'zod';

export const memberSchema = z.object({
  name: z.string().trim().min(1).max(120),
  employee_id: z.string().trim().min(2).max(40),
  email: z.string().trim().max(200).optional().nullable().transform((v) => (v ? v : null)),
});

export const privilegedSchema = {
  privileged: z.boolean().optional().default(false),
  reason: z.string().trim().max(500).optional().nullable(),
};

export const uuid = z.string().uuid();

export const walkInSchema = z.object({
  team_id: uuid,
  team_name: z.string().trim().min(2).max(60),
  members: z.array(memberSchema).min(2).max(4),
  ...privilegedSchema,
});

export const renameSchema = z.object({ name: z.string().trim().min(2).max(60) });
export const addMemberSchema = z.object({ member: memberSchema, ...privilegedSchema });

export const slotActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('update'), name: z.string().trim().min(1).max(120), email: z.string().trim().max(200).nullable().optional() }),
  z.object({ action: z.literal('replace'), member: memberSchema, reason: z.string().trim().min(10).max(500), privileged: z.boolean().optional().default(false) }),
  z.object({ action: z.literal('remove'), reason: z.string().trim().min(3).max(500), privileged: z.boolean().optional().default(false) }),
  z.object({ action: z.literal('eligibility'), eligible: z.boolean(), reason: z.string().trim().min(3).max(500) }),
]);

export const provisionSchema = z.object({ count: z.number().int().min(1).max(100) });
export const reissueSchema = z.object({ credential_ids: z.array(uuid).min(1).max(500), reason: z.string().trim().min(10).max(500) });
export const slipsSchema = z.object({ team_ids: z.array(uuid).max(2000).optional().nullable(), with_pins: z.boolean(), include_unregistered: z.boolean().optional() });
export const flagsSchema = z.object({ problems_open: z.boolean().optional(), goodies_open: z.boolean().optional(), member_edits_frozen: z.boolean().optional() });
export const mappingSchema = z.object({ mapping: z.record(z.string(), z.string().max(200).optional()) });
export const commitSchema = z.object({ ...privilegedSchema });

export const teamLoginSchema = z.object({ team_number: z.coerce.number().int().min(1).max(9999), pin: z.string().max(12) });
export const participantLoginSchema = z.object({ employee_id: z.string().trim().min(1).max(40), pin: z.string().max(12) });
export const lockSchema = z.object({ problem_id: uuid });
export const reserveSchema = z.object({ goodie_id: uuid });
