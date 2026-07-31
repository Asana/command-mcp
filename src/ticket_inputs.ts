import { z } from "zod";

export const TicketIdentifierSchema = z
  .string()
  .trim()
  .min(1, "Ticket identifier is required")
  .describe("An Asana task GID, a Command short ID such as ABC-42, or an Asana task URL");

function isRealCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const maximumDay = daysInMonth[month - 1];
  return maximumDay !== undefined && day >= 1 && day <= maximumDay;
}

export const DateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date in YYYY-MM-DD form")
  .refine(isRealCalendarDate, "Expected a real calendar date")
  .describe("A calendar date in YYYY-MM-DD form");

export function withTicketId<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).extend({
    ticket_id: TicketIdentifierSchema,
  });
}

export type TicketIdentifier = z.infer<typeof TicketIdentifierSchema>;
export type DateOnly = z.infer<typeof DateOnlySchema>;
