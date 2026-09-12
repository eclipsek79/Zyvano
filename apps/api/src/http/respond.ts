/**
 * Response envelope helpers.
 *
 * Every successful response uses one of these shapes so the client can rely on
 * `data` / `meta` never changing meaning.
 */
import type { Response } from 'express';

import type { DeletedResponse, ItemResponse, ListResponse, PaginationMeta } from '@zyvano/shared';

export function item<T>(data: T): ItemResponse<T> {
  return { data };
}

export function paginationMeta(input: { page: number; perPage: number; total: number }): PaginationMeta {
  return {
    page: input.page,
    perPage: input.perPage,
    total: input.total,
    totalPages: input.perPage > 0 ? Math.ceil(input.total / input.perPage) : 0,
  };
}

export function list<T>(items: T[], input: { page: number; perPage: number; total: number }): ListResponse<T> {
  return { data: items, meta: paginationMeta(input) };
}

export function deleted(id: string): DeletedResponse {
  return { data: { id, deleted: true } };
}

/** 201 with the created resource. */
export function created<T>(res: Response, data: T): void {
  res.status(201).json(item(data));
}

/** 202 for operations that were accepted for asynchronous processing. */
export function accepted<T>(res: Response, data: T): void {
  res.status(202).json(item(data));
}

export function ok<T>(res: Response, data: T): void {
  res.status(200).json(item(data));
}

export function okList<T>(res: Response, items: T[], meta: { page: number; perPage: number; total: number }): void {
  res.status(200).json(list(items, meta));
}

export function noContent(res: Response): void {
  res.status(204).send();
}
