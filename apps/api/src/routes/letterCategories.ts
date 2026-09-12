import { Hono } from "hono";
import type { AppEnv } from "../index";
import { requireAuth } from "./auth";

const letterCategories = new Hono<AppEnv>();

letterCategories.use("*", requireAuth);

interface CategoryRow {
  id: number;
  name: string;
  drafting_instruction: string;
  sort_order: number;
}

function toCategory(row: CategoryRow) {
  return { id: row.id, name: row.name, draftingInstruction: row.drafting_instruction };
}

letterCategories.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, drafting_instruction, sort_order FROM letter_categories ORDER BY sort_order, name",
  ).all<CategoryRow>();

  return c.json(results.map(toCategory));
});

letterCategories.post("/", async (c) => {
  const { name, draftingInstruction } = await c.req.json<{ name?: string; draftingInstruction?: string }>();
  const trimmed = name?.trim();
  if (!trimmed) {
    return c.json({ error: "Enter a letter type name" }, 400);
  }

  const duplicate = await c.env.DB.prepare("SELECT id FROM letter_categories WHERE name = ?").bind(trimmed).first();
  if (duplicate) {
    return c.json({ error: "That letter type already exists" }, 400);
  }

  const maxOrder = await c.env.DB.prepare("SELECT MAX(sort_order) as maxOrder FROM letter_categories").first<{
    maxOrder: number | null;
  }>();
  const nextOrder = (maxOrder?.maxOrder ?? 0) + 1;

  const created = await c.env.DB.prepare(
    "INSERT INTO letter_categories (name, drafting_instruction, sort_order) VALUES (?, ?, ?) RETURNING id, name, drafting_instruction, sort_order",
  )
    .bind(trimmed, draftingInstruction?.trim() ?? "", nextOrder)
    .first<CategoryRow>();

  if (!created) {
    return c.json({ error: "Could not save the letter type" }, 500);
  }

  return c.json(toCategory(created), 201);
});

letterCategories.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: "Invalid letter type id" }, 400);
  }

  const { name, draftingInstruction } = await c.req.json<{ name?: string; draftingInstruction?: string }>();
  const trimmed = name?.trim();
  if (!trimmed) {
    return c.json({ error: "Enter a letter type name" }, 400);
  }

  const duplicate = await c.env.DB.prepare("SELECT id FROM letter_categories WHERE name = ? AND id != ?")
    .bind(trimmed, id)
    .first();
  if (duplicate) {
    return c.json({ error: "That letter type already exists" }, 400);
  }

  const updated = await c.env.DB.prepare(
    "UPDATE letter_categories SET name = ?, drafting_instruction = ? WHERE id = ? RETURNING id, name, drafting_instruction, sort_order",
  )
    .bind(trimmed, draftingInstruction?.trim() ?? "", id)
    .first<CategoryRow>();

  if (!updated) {
    return c.json({ error: "Letter type not found" }, 404);
  }

  return c.json(toCategory(updated));
});

letterCategories.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: "Invalid letter type id" }, 400);
  }

  const existing = await c.env.DB.prepare("SELECT id FROM letter_categories WHERE id = ?").bind(id).first();
  if (!existing) {
    return c.json({ error: "Letter type not found" }, 404);
  }

  // Like document categories, a saved letter just becomes uncategorised
  // rather than blocking deletion or needing reassignment.
  await c.env.DB.prepare("UPDATE letters SET letter_category_id = NULL WHERE letter_category_id = ?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM letter_categories WHERE id = ?").bind(id).run();

  return c.json({ ok: true });
});

export default letterCategories;
