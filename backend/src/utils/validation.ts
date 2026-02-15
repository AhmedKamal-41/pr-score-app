import { z } from 'zod';
import { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Validates request body/query/params against a Zod schema
 */
export function validateRequest<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown
): z.infer<T> {
  return schema.parse(data);
}

/**
 * Safe validation that returns result instead of throwing
 */
export function safeValidate<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown
): { success: true; data: z.infer<T> } | { success: false; error: z.ZodError } {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Validation schemas for API routes
 */
export const schemas = {
  // Pagination query params (offset-based)
  pagination: z.object({
    limit: z.coerce.number().int().positive().max(100).default(50),
    offset: z.coerce.number().int().nonnegative().default(0),
  }),
  
  // Page-based pagination (alternative)
  paginationPage: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(10),
  }),
  
  // ID path parameter
  idParam: z.object({
    id: z.string().uuid(),
  }),
};

