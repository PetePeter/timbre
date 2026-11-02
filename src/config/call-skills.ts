export interface CallSkillField {
  key: string;
  label: string;
  required: boolean;
}

export interface CallSkill {
  id: string;
  name: string;
  description: string;
  goal: string;
  steps: string[];
  allowedInfo: string[];
  fields: CallSkillField[];
  defaultNumber?: string;
}

export const starterCallSkills: CallSkill[] = [
  {
    id: 'book-appointment', name: 'Book an appointment',
    description: 'Arrange an appointment with a business, such as a mechanic, clinic or salon.',
    goal: 'Book an appointment that matches the requested service and availability.',
    steps: ['Ask about the requested service.', 'Find the earliest suitable time.', 'Confirm the date, time and any preparation needed.'],
    allowedInfo: ['The service or reason for the appointment.', 'Availability details entered by the owner.'],
    fields: [
      { key: 'number', label: 'Business phone number', required: true },
      { key: 'business', label: 'Business', required: true },
      { key: 'service', label: 'Service or reason', required: true },
      { key: 'availability', label: 'Preferred availability', required: false },
    ],
  },
  {
    id: 'leave-message', name: 'Leave a message',
    description: 'Reach a person and pass along a short message, for example to a school or office.',
    goal: 'Deliver the message to the named person or find out when they can be reached.',
    steps: ['Ask for the named person.', 'If they are unavailable, ask when to call back.', 'Read the message clearly and confirm it was received.'],
    allowedInfo: ['The message entered by the owner.', 'The caller name, if provided.'],
    fields: [
      { key: 'number', label: 'Phone number', required: true },
      { key: 'person', label: 'Person to ask for', required: true },
      { key: 'message', label: 'Message', required: true },
      { key: 'callerName', label: 'Caller name', required: false },
    ],
  },
  {
    id: 'report-fault', name: 'Report a fault',
    description: 'Report a service, utility or product fault and ask what happens next.',
    goal: 'Report the fault and record the next steps or reference number.',
    steps: ['Describe the fault clearly.', 'Answer relevant questions using the provided details.', 'Ask for a reference number and expected next step.'],
    allowedInfo: ['The fault description entered by the owner.', 'An account reference entered by the owner.'],
    fields: [
      { key: 'number', label: 'Service phone number', required: true },
      { key: 'business', label: 'Service or business', required: true },
      { key: 'fault', label: 'Fault description', required: true },
      { key: 'accountReference', label: 'Account reference', required: false },
    ],
  },
];

/** Missing means a pre-feature config; an explicit empty list means the owner removed all skills. */
export function normalizeCallSkills(value: unknown): CallSkill[] {
  if (value === undefined) return structuredClone(starterCallSkills);
  if (!Array.isArray(value)) return [];

  const ids = new Set<string>();
  const skills: CallSkill[] = [];
  for (const item of value) {
    const skill = normalizeCallSkill(item);
    if (!skill || ids.has(skill.id)) continue;
    ids.add(skill.id);
    skills.push(skill);
  }
  return skills;
}

function normalizeCallSkill(value: unknown): CallSkill | null {
  if (!isObject(value)) return null;
  const id = text(value.id, 80);
  const name = text(value.name, 100);
  const description = text(value.description, 800);
  const goal = text(value.goal, 2000);
  if (!/^[\w.-]{1,80}$/.test(id) || !name || !description || !goal) return null;

  const fields: CallSkillField[] = [];
  const keys = new Set<string>();
  if (Array.isArray(value.fields)) {
    for (const candidate of value.fields.slice(0, 30)) {
      if (!isObject(candidate)) continue;
      const key = text(candidate.key, 40);
      const label = text(candidate.label, 100);
      if (!/^[a-z][a-zA-Z0-9_]*$/.test(key) || !label || keys.has(key) || typeof candidate.required !== 'boolean') continue;
      keys.add(key);
      fields.push({ key, label, required: candidate.required });
    }
  }
  if (Array.isArray(value.fields) && value.fields.length > 0 && fields.length === 0) return null;

  const defaultNumber = text(value.defaultNumber, 120);
  if (!fields.some((field) => field.key === 'number') && !defaultNumber) return null;
  return {
    id, name, description, goal,
    steps: textList(value.steps, 40, 500),
    allowedInfo: textList(value.allowedInfo, 40, 300),
    fields,
    ...(defaultNumber ? { defaultNumber } : {}),
  };
}

function textList(value: unknown, count: number, length: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, count).map((item) => text(item, length)).filter(Boolean);
}

function text(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
