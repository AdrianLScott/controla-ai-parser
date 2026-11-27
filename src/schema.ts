import { z } from 'zod';

export const CATEGORIES = [
  'Food',
  'Transport',
  'Travel',
  'Entertainment',
  'Health',
  'Shopping',
  'Utilities',
  'Other',
] as const;

export const PAYMENT_METHODS = ['Cash', 'Credit', 'Debit', 'Transfer'] as const;

export type Category = (typeof CATEGORIES)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * The only shapes the model is allowed to return.
 * `is_expense: false` gives the model a legitimate way to say "this isn't a purchase"
 * instead of inventing one (greetings, questions, income, Whisper noise that slipped past the guards).
 */
export const ModelOutputSchema = z.discriminatedUnion('is_expense', [
  z.object({
    is_expense: z.literal(true),
    amount: z.number().nonnegative(),
    category: z.enum(CATEGORIES),
    payment_method: z.enum(PAYMENT_METHODS),
    description: z.string().min(1).max(120),
    /** The day the money was spent, only when the text says one ("ayer", "el lunes"). Null otherwise. */
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
  }),
  z.object({
    is_expense: z.literal(false),
    reason: z.string().max(200).optional(),
  }),
]);

export type ModelOutput = z.infer<typeof ModelOutputSchema>;

/** What gets stored. Money is always an integer number of cents. */
export interface Movement {
  amount: number;
  category: Category;
  payment_method: PaymentMethod;
  description: string;
  /** Day the money was spent, `YYYY-MM-DD` in the user's calendar. Today when the text doesn't say. */
  date: string;
}

export function toCents(amount: number): number {
  return Math.round(amount * 100);
}
