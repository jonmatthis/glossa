export interface Settings {
  openrouter_key: string
  groq_key: string
  openrouter_model: string
  target_language: string
  native_language: string
  microphone_device_id: string | null
}

export interface GuidedToken {
  text: string
  gloss: string | null
  pos: string | null
  notable: boolean
}

export interface Mechanic {
  title: string
  cefr: string | null
  body: string
  example: string | null
  contrast: string | null
}

export interface Scaffolds {
  replies: string[]
  frames: string[]
  starters: string[]
}

export interface GuidedTurnResult {
  reply: string
  translation: string | null
  tokens: GuidedToken[]
  features: string[]
  mechanics: Mechanic[]
  scaffolds: Scaffolds
}

export interface StoryToken {
  text: string
  gloss: string | null
}

export interface StoryParagraph {
  tokens: StoryToken[]
}

export interface Story {
  title: string
  paragraphs: StoryParagraph[]
}

export type GuidedEvent =
  | { type: 'reply_delta'; text: string }
  | { type: 'reply_done'; reply: string }
  | { type: 'analysis_done'; turn: GuidedTurnResult }
  | { type: 'analysis_failed'; error: string }
  | { type: 'plan_updated'; plan: TeachingPlan; profile: Profile }

export interface RecurringError {
  error: string
  correction: string
  seen_count: number
}

export interface TaughtMechanic {
  mechanic: string
  last_seen_turn: number
}

export interface TeachingPlan {
  session_focus: string[]
  recurring_errors: RecurringError[]
  vocab_recycle: string[]
  avoid: string[]
  learner_interests: string[]
  energy_read: string
  correction_budget: number
  taught_ledger: TaughtMechanic[]
}

export interface Profile {
  about: string
  level_notes: string
  strengths: string[]
  weaknesses: string[]
  interests: string[]
  long_term_errors: RecurringError[]
  sessions: number
}

export interface ObserverDocuments {
  plan: TeachingPlan
  profile: Profile
}

export type AnalysisState = 'pending' | 'done' | 'failed'

export type Level = 'beginner' | 'intermediate' | 'advanced'

export type AssistLevel = 0 | 1 | 2 | 3
