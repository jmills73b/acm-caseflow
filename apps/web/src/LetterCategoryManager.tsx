import { useState, type FormEvent } from "react";
import { Icon } from "./icons";
import { addLetterCategory, deleteLetterCategory, updateLetterCategory, type LetterCategory } from "./api";

// Unlike the plain-name category managers (documents, expenses, etc.),
// each letter type also carries a drafting instruction -- the house style
// fed into the drafting agent's prompt (see routes/letters.ts) -- so this
// can't reuse the single-input .category-row layout; each row is its own
// small edit form instead.
export function LetterCategoryManager({
  categories,
  onChanged,
}: {
  categories: LetterCategory[];
  onChanged: () => Promise<void>;
}) {
  const [newName, setNewName] = useState("");
  const [newInstruction, setNewInstruction] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editValues, setEditValues] = useState<Record<number, { name: string; draftingInstruction: string }>>({});
  const [savingId, setSavingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  function valuesFor(cat: LetterCategory) {
    return editValues[cat.id] ?? { name: cat.name, draftingInstruction: cat.draftingInstruction };
  }

  function setValue(id: number, cat: LetterCategory, field: "name" | "draftingInstruction", value: string) {
    setEditValues((prev) => ({ ...prev, [id]: { ...valuesFor(cat), [field]: value } }));
  }

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const trimmed = newName.trim();
    if (!trimmed) {
      setError("Enter a letter type name");
      return;
    }

    setAdding(true);
    try {
      await addLetterCategory(trimmed, newInstruction.trim());
      setNewName("");
      setNewInstruction("");
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add that letter type");
    } finally {
      setAdding(false);
    }
  }

  async function handleSave(cat: LetterCategory) {
    const values = valuesFor(cat);
    const trimmed = values.name.trim();
    if (!trimmed) {
      setError("Enter a letter type name");
      return;
    }

    setSavingId(cat.id);
    setError(null);
    try {
      await updateLetterCategory(cat.id, trimmed, values.draftingInstruction.trim());
      setEditValues((prev) => {
        const next = { ...prev };
        delete next[cat.id];
        return next;
      });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that letter type");
    } finally {
      setSavingId(null);
    }
  }

  async function handleDelete(id: number, name: string) {
    const confirmed = window.confirm(`Delete "${name}"? Any saved letters of this type will become uncategorised.`);
    if (!confirmed) return;

    setDeletingId(id);
    setError(null);
    try {
      await deleteLetterCategory(id);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete that letter type");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div>
      {categories.map((cat) => {
        const values = valuesFor(cat);
        const dirty = values.name !== cat.name || values.draftingInstruction !== cat.draftingInstruction;
        return (
          <div className="edit-panel" key={cat.id}>
            <div className="edit-row">
              <label className="edit-field">
                <span>Name</span>
                <input
                  className="input-compact"
                  value={values.name}
                  onChange={(event) => setValue(cat.id, cat, "name", event.target.value)}
                />
              </label>
            </div>
            <label className="edit-field" style={{ marginBottom: 16 }}>
              <span>Drafting instruction</span>
              <textarea
                rows={2}
                value={values.draftingInstruction}
                onChange={(event) => setValue(cat.id, cat, "draftingInstruction", event.target.value)}
                placeholder="e.g. Always state this is an estimate, not an invoice."
              />
            </label>
            <div className="row-actions">
              <button type="button" onClick={() => handleSave(cat)} disabled={!dirty || savingId === cat.id}>
                <Icon name="save" /> {savingId === cat.id ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => handleDelete(cat.id, cat.name)}
                disabled={deletingId === cat.id}
              >
                <Icon name="delete" /> {deletingId === cat.id ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        );
      })}

      <p className="edit-panel-title">Add a letter type</p>
      <form onSubmit={handleAdd} className="form">
        <label>
          Name
          <input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="e.g. Payment chase" />
        </label>
        <label>
          Drafting instruction
          <textarea
            rows={2}
            value={newInstruction}
            onChange={(event) => setNewInstruction(event.target.value)}
            placeholder="e.g. Always state the 14-day payment window."
          />
        </label>
        <button type="submit" disabled={adding}>
          <Icon name="add" /> {adding ? "Adding…" : "Add letter type"}
        </button>
      </form>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
