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
    id: 'get-information', name: 'Get information',
    description: 'Find out a fact from a business or person, such as opening hours, a price, or who called and why.',
    goal: 'Get a clear answer to the question and report it back.',
    steps: [
      'Choose the general information option in any phone menu.',
      'Listen to recorded information before asking; it may already answer the question.',
      'Ask the one question plainly.',
      'Repeat the answer back to confirm it.',
      'If they cannot answer, ask who can, or when to call back.',
    ],
    allowedInfo: ['The question.', 'The requester\'s first name.'],
    fields: [
      { key: 'number', label: 'Phone number', required: true },
      { key: 'question', label: 'What to find out', required: true },
    ],
  },
  {
    id: 'arrange-something', name: 'Arrange something',
    description: 'Book, change or cancel something, or report a problem with an order or service.',
    goal: 'Get it done, or get a reference number and the next step.',
    steps: [
      'Choose the bookings or support option in any phone menu.',
      'Give names, dates and details from the task only.',
      'Use ask_requester before agreeing to any price, date or term the task does not cover.',
      'At the end, confirm the date, time and any reference number.',
    ],
    allowedInfo: ['Names, booking or order references, dates and details in the task.', 'Never card or bank numbers.'],
    fields: [
      { key: 'number', label: 'Phone number', required: true },
      { key: 'business', label: 'Business or service', required: true },
      { key: 'request', label: 'What to arrange', required: true },
      { key: 'details', label: 'Dates, references and other details', required: false },
    ],
  },
  {
    id: 'deliver-message', name: 'Deliver a message',
    description: 'Tell someone something on the requester\'s behalf.',
    goal: 'The named person hears the message and acknowledges it.',
    steps: [
      'Check you are talking to the named person.',
      'Say who the message is from.',
      'Give the message in one or two sentences.',
      'Ask them to confirm they got it, and offer to pass back a short reply.',
      'On voicemail, leave the message once, then hang up.',
    ],
    allowedInfo: ['The message.', 'The requester\'s first name.'],
    fields: [
      { key: 'number', label: 'Phone number', required: true },
      { key: 'person', label: 'Person', required: true },
      { key: 'message', label: 'Message', required: true },
    ],
  },
  {
    id: 'connect-people', name: 'Connect people',
    description: 'Reach a named person so the requester can talk to them directly.',
    goal: 'Reach the named person and join the requester to the call.',
    steps: [
      'Ask for the person by name.',
      'Say briefly why you are calling.',
      'Ask: "Can you hold a moment while I bring them in?"',
      'Join the requester only after they agree.',
      'If the person is unavailable, ask for a good time to call back.',
    ],
    allowedInfo: ['The requester\'s first name.', 'The topic in the task.'],
    fields: [
      { key: 'number', label: 'Phone number', required: true },
      { key: 'person', label: 'Person to reach', required: true },
      { key: 'topic', label: 'Topic', required: false },
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
