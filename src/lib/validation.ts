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

const optUrl = z.string().trim().max(1000).optional().nullable().transform((v) => (v ? v : null));
export const problemSchema = z.object({
  id: uuid.optional().nullable(),
  code: z.string().trim().min(1).max(20),
  title: z.string().trim().min(2).max(160),
  summary: z.string().trim().max(2000).optional().nullable(),
  capacity: z.number().int().min(1).max(10000),
  document_url: optUrl,
  is_active: z.boolean().optional().default(true),
  sort_order: z.number().int().min(0).max(100000).optional().nullable(),
});
export const goodieSchema = z.object({
  id: uuid.optional().nullable(),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional().nullable(),
  stock: z.number().int().min(0).max(100000),
  image_url: optUrl,
  is_active: z.boolean().optional().default(true),
  sort_order: z.number().int().min(0).max(100000).optional().nullable(),
});

export const surveySubmitSchema = z.object({
  employee_id: z.string().trim().min(2, 'Enter your employee ID').max(40),
  name: z.string().trim().max(100).default(''), // optional when the employee ID is in the list (the list's name is used)
  goodie_id: z.string().uuid().nullish(),
  meal: z.enum(['veg', 'nonveg']).nullish(),
  attending: z.boolean({ message: 'Tell us whether you will attend on 27 November' }),
}).refine((v) => !v.attending || !!v.goodie_id, { message: 'Choose a goodie', path: ['goodie_id'] })
  .refine((v) => !v.attending || !!v.meal, { message: 'Choose Veg or Non-veg', path: ['meal'] });

export const photoSchema = z.object({
  mime: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  data: z.string().min(10).max(800_000).regex(/^[A-Za-z0-9+/=]+$/, 'Invalid image data'),
});
