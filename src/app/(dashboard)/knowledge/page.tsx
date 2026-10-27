"use client";

import { Header } from "@/components/layout/header";
import { cn } from "@/lib/utils";
import {
  BookOpen,
  Plus,
  Pencil,
  Trash2,
  X,
  FolderOpen,
  FileText,
  ChevronRight,
  AlertCircle,
  Star,
  ArrowUp,
  Minus,
  ToggleLeft,
  ToggleRight,
  Loader2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { submitJson } from "@/lib/http/submit-json";
import { useReportWrite } from "@/lib/hooks/use-report-write";
import { LoadFailed } from "@/components/ui/load-failed";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CategoryWithCount {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  sortOrder: number;
  _count: { entries: number };
}

interface EntryCategory {
  id: string;
  name: string;
  color: string;
  icon: string;
}

interface KnowledgeEntry {
  id: string;
  categoryId: string;
  category: EntryCategory;
  title: string;
  content: string;
  priority: number;
  isActive: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Priority helpers
// ---------------------------------------------------------------------------

const PRIORITIES = [
  { value: 0, label: "Normal", icon: Minus, className: "bg-gray-100 text-gray-600" },
  { value: 1, label: "Medium", icon: ArrowUp, className: "bg-yellow-100 text-yellow-700" },
  { value: 2, label: "High", icon: ArrowUp, className: "bg-orange-100 text-orange-700" },
  { value: 3, label: "Critical", icon: Star, className: "bg-red-100 text-red-700" },
];

function getPriority(value: number) {
  return PRIORITIES.find((p) => p.value === value) || PRIORITIES[0];
}

// ---------------------------------------------------------------------------
// Category icon mapping (lucide subset as colored circles with letter)
// ---------------------------------------------------------------------------

function CategoryIcon({ color, name }: { color: string; name: string }) {
  return (
    <span
      className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-white text-sm font-semibold flex-shrink-0"
      style={{ backgroundColor: color }}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function KnowledgeBasePage() {
  // --- State ---
  const [categories, setCategories] = useState<CategoryWithCount[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [loadingCategories, setLoadingCategories] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [entriesFailed, setEntriesFailed] = useState(false);
  const reportWrite = useReportWrite();
  const [loadingEntries, setLoadingEntries] = useState(false);

  // Category modal
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [editingCategory, setEditingCategory] = useState<CategoryWithCount | null>(null);
  const [categoryForm, setCategoryForm] = useState({ name: "", description: "", icon: "folder", color: "#4A7C9B" });
  const [savingCategory, setSavingCategory] = useState(false);

  // Entry modal
  const [showEntryModal, setShowEntryModal] = useState(false);
  const [editingEntry, setEditingEntry] = useState<KnowledgeEntry | null>(null);
  const [entryForm, setEntryForm] = useState({ title: "", content: "", priority: 0 });
  const [savingEntry, setSavingEntry] = useState(false);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<{ type: "category" | "entry"; id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  // --- Data fetching ---

  const fetchCategories = useCallback(async () => {
    setLoadingCategories(true);
    try {
      const res = await fetch("/api/knowledge/categories");
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      setCategories(data.data);
      setLoadFailed(false);
    } catch (err) {
      console.error("Failed to fetch categories:", err);
      setLoadFailed(true);
    } finally {
      setLoadingCategories(false);
    }
  }, []);

  const fetchEntries = useCallback(async (categoryId: string) => {
    setLoadingEntries(true);
    try {
      const res = await fetch(`/api/knowledge/entries?categoryId=${categoryId}`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      setEntries(data.data);
      setEntriesFailed(false);
    } catch (err) {
      console.error("Failed to fetch entries:", err);
      setEntriesFailed(true);
    } finally {
      setLoadingEntries(false);
    }
  }, []);

  useEffect(() => {
    fetchCategories();
  }, [fetchCategories]);

  useEffect(() => {
    if (selectedCategoryId) {
      fetchEntries(selectedCategoryId);
    } else {
      setEntries([]);
    }
  }, [selectedCategoryId, fetchEntries]);

  const selectedCategory = categories.find((c) => c.id === selectedCategoryId) || null;

  // --- Category CRUD ---

  function openCategoryModal(category?: CategoryWithCount) {
    if (category) {
      setEditingCategory(category);
      setCategoryForm({
        name: category.name,
        description: category.description,
        icon: category.icon,
        color: category.color,
      });
    } else {
      setEditingCategory(null);
      setCategoryForm({ name: "", description: "", icon: "folder", color: "#4A7C9B" });
    }
    setShowCategoryModal(true);
  }

  async function saveCategory() {
    if (!categoryForm.name.trim()) return;
    setSavingCategory(true);
    const result = await submitJson(
      editingCategory ? `/api/knowledge/categories/${editingCategory.id}` : "/api/knowledge/categories",
      editingCategory ? "PUT" : "POST",
      categoryForm
    );
    setSavingCategory(false);
    if (!reportWrite("Saving the category", result)) return; // the form stays open with what was typed
    setShowCategoryModal(false);
    await fetchCategories();
  }

  // --- Entry CRUD ---

  function openEntryModal(entry?: KnowledgeEntry) {
    if (entry) {
      setEditingEntry(entry);
      setEntryForm({ title: entry.title, content: entry.content, priority: entry.priority });
    } else {
      setEditingEntry(null);
      setEntryForm({ title: "", content: "", priority: 0 });
    }
    setShowEntryModal(true);
  }

  async function saveEntry() {
    if (!entryForm.title.trim() || !selectedCategoryId) return;
    setSavingEntry(true);
    const result = await submitJson(
      editingEntry ? `/api/knowledge/entries/${editingEntry.id}` : "/api/knowledge/entries",
      editingEntry ? "PUT" : "POST",
      { ...entryForm, categoryId: selectedCategoryId }
    );
    setSavingEntry(false);
    if (!reportWrite("Saving the entry", result)) return; // the form stays open with what was typed
    setShowEntryModal(false);
    await fetchEntries(selectedCategoryId);
    await fetchCategories();
  }

  async function toggleEntryActive(entry: KnowledgeEntry) {
    const result = await submitJson(`/api/knowledge/entries/${entry.id}`, "PUT", { isActive: !entry.isActive });
    if (!reportWrite(entry.isActive ? "Turning the entry off" : "Turning the entry on", result)) return;
    if (selectedCategoryId) await fetchEntries(selectedCategoryId);
  }

  // --- Delete ---

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    const result = await submitJson(
      deleteTarget.type === "category" ? `/api/knowledge/categories/${deleteTarget.id}` : `/api/knowledge/entries/${deleteTarget.id}`,
      "DELETE"
    );
    setDeleting(false);
    setDeleteTarget(null);
    if (!reportWrite(deleteTarget.type === "category" ? "Deleting the category" : "Deleting the entry", result)) return;
    if (deleteTarget.type === "category") {
      if (selectedCategoryId === deleteTarget.id) {
        setSelectedCategoryId(null);
        setEntries([]);
      }
      await fetchCategories();
    } else if (selectedCategoryId) {
      await fetchEntries(selectedCategoryId);
      await fetchCategories();
    }
  }

  // --- Category color presets ---
  const colorPresets = [
    "#4A7C9B", "#2D5A7B", "#C4956A", "#6B8E5B", "#9B6B9E",
    "#C75C5C", "#D4964A", "#5B8E8E", "#7C6B9B", "#4A9B7C",
  ];

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <>
      <Header
        title="Knowledge Base"
        description="Manage your AI's knowledge and responses"
      />

      <div className="flex-1 overflow-hidden flex">
        {/* ================= LEFT PANEL: Categories ================= */}
        <div className="w-80 flex-shrink-0 border-r border-ziyrak-border bg-ziyrak-surface flex flex-col">
          <div className="px-4 py-3 border-b border-ziyrak-border flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ziyrak-text">Categories</h3>
            <button
              onClick={() => openCategoryModal()}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-white bg-ziyrak-primary hover:bg-ziyrak-primary-dark rounded-lg transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {loadingCategories ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-ziyrak-text-light" />
              </div>
            ) : loadFailed ? (
              <LoadFailed what="knowledge categories" onRetry={fetchCategories} />
            ) : categories.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <FolderOpen className="h-10 w-10 mx-auto mb-3 text-ziyrak-text-light opacity-40" />
                <p className="text-sm font-medium text-ziyrak-text-light">No categories yet</p>
                <p className="text-xs text-ziyrak-text-light mt-1">
                  Create your first category to start organizing knowledge entries.
                </p>
                <button
                  onClick={() => openCategoryModal()}
                  className="mt-4 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-ziyrak-primary border border-ziyrak-primary/30 hover:bg-ziyrak-primary-50 rounded-lg transition-colors"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Create Category
                </button>
              </div>
            ) : (
              <div className="py-1">
                {categories.map((cat) => (
                  <div
                    key={cat.id}
                    className={cn(
                      "group flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors",
                      selectedCategoryId === cat.id
                        ? "bg-ziyrak-primary-50 border-r-2 border-ziyrak-primary"
                        : "hover:bg-ziyrak-bg"
                    )}
                    onClick={() => setSelectedCategoryId(cat.id)}
                  >
                    <CategoryIcon color={cat.color} name={cat.name} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-medium text-ziyrak-text truncate">
                          {cat.name}
                        </p>
                        <span className="text-xs text-ziyrak-text-light flex-shrink-0 ml-2">
                          {cat._count.entries}
                        </span>
                      </div>
                      {cat.description && (
                        <p className="text-xs text-ziyrak-text-light truncate mt-0.5">
                          {cat.description}
                        </p>
                      )}
                    </div>
                    <div className="hidden group-hover:flex items-center gap-0.5 flex-shrink-0">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openCategoryModal(cat);
                        }}
                        className="p-1 text-ziyrak-text-light hover:text-ziyrak-primary rounded transition-colors"
                        title="Edit category"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTarget({ type: "category", id: cat.id, name: cat.name });
                        }}
                        className="p-1 text-ziyrak-text-light hover:text-red-600 rounded transition-colors"
                        title="Delete category"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {selectedCategoryId === cat.id && (
                      <ChevronRight className="h-4 w-4 text-ziyrak-primary flex-shrink-0" />
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ================= RIGHT PANEL: Entries ================= */}
        <div className="flex-1 flex flex-col min-w-0 bg-ziyrak-bg">
          {!selectedCategory ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <BookOpen className="h-12 w-12 mx-auto mb-4 text-ziyrak-text-light opacity-30" />
                <p className="text-lg font-medium text-ziyrak-text-light">
                  Select a category
                </p>
                <p className="text-sm text-ziyrak-text-light mt-1">
                  Choose a category from the left panel to view and manage its entries.
                </p>
              </div>
            </div>
          ) : (
            <>
              {/* Entries header */}
              <div className="px-6 py-3 border-b border-ziyrak-border bg-ziyrak-surface flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <CategoryIcon color={selectedCategory.color} name={selectedCategory.name} />
                  <div>
                    <h3 className="text-sm font-semibold text-ziyrak-text">
                      {selectedCategory.name}
                    </h3>
                    {selectedCategory.description && (
                      <p className="text-xs text-ziyrak-text-light">
                        {selectedCategory.description}
                      </p>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => openEntryModal()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-ziyrak-primary hover:bg-ziyrak-primary-dark rounded-lg transition-colors"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add Entry
                </button>
              </div>

              {/* Entries list */}
              <div className="flex-1 overflow-y-auto p-6">
                {loadingEntries ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-5 w-5 animate-spin text-ziyrak-text-light" />
                  </div>
                ) : entriesFailed ? (
                  <LoadFailed what="entries" onRetry={() => selectedCategoryId && fetchEntries(selectedCategoryId)} />
                ) : entries.length === 0 ? (
                  <div className="text-center py-12">
                    <FileText className="h-10 w-10 mx-auto mb-3 text-ziyrak-text-light opacity-40" />
                    <p className="text-sm font-medium text-ziyrak-text-light">
                      No entries in this category
                    </p>
                    <p className="text-xs text-ziyrak-text-light mt-1">
                      Add knowledge entries that the AI can use when responding to customers.
                    </p>
                    <button
                      onClick={() => openEntryModal()}
                      className="mt-4 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-ziyrak-primary border border-ziyrak-primary/30 hover:bg-ziyrak-primary-50 rounded-lg transition-colors"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add First Entry
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {entries.map((entry) => {
                      const priority = getPriority(entry.priority);
                      const PriorityIcon = priority.icon;
                      const contentPreview = entry.content
                        ? entry.content.split("\n")[0].slice(0, 120)
                        : "";

                      return (
                        <div
                          key={entry.id}
                          className={cn(
                            "bg-ziyrak-surface rounded-xl border border-ziyrak-border p-4 transition-all hover:shadow-sm",
                            !entry.isActive && "opacity-60"
                          )}
                        >
                          <div className="flex items-start gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <h4 className="text-sm font-medium text-ziyrak-text">
                                  {entry.title}
                                </h4>
                                <span
                                  className={cn(
                                    "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium",
                                    priority.className
                                  )}
                                >
                                  <PriorityIcon className="h-3 w-3" />
                                  {priority.label}
                                </span>
                                {!entry.isActive && (
                                  <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-500">
                                    Inactive
                                  </span>
                                )}
                              </div>
                              {contentPreview && (
                                <p className="text-xs text-ziyrak-text-light mt-1 truncate">
                                  {contentPreview}
                                </p>
                              )}
                            </div>

                            <div className="flex items-center gap-1 flex-shrink-0">
                              <button
                                onClick={() => toggleEntryActive(entry)}
                                className={cn(
                                  "p-1.5 rounded transition-colors",
                                  entry.isActive
                                    ? "text-ziyrak-primary hover:bg-ziyrak-primary-50"
                                    : "text-ziyrak-text-light hover:bg-gray-100"
                                )}
                                title={entry.isActive ? "Deactivate" : "Activate"}
                              >
                                {entry.isActive ? (
                                  <ToggleRight className="h-4 w-4" />
                                ) : (
                                  <ToggleLeft className="h-4 w-4" />
                                )}
                              </button>
                              <button
                                onClick={() => openEntryModal(entry)}
                                className="p-1.5 text-ziyrak-text-light hover:text-ziyrak-primary hover:bg-ziyrak-primary-50 rounded transition-colors"
                                title="Edit entry"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() =>
                                  setDeleteTarget({ type: "entry", id: entry.id, name: entry.title })
                                }
                                className="p-1.5 text-ziyrak-text-light hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                                title="Delete entry"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ================= CATEGORY MODAL ================= */}
      {showCategoryModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setShowCategoryModal(false)}
          />
          <div className="relative bg-ziyrak-surface rounded-xl shadow-xl border border-ziyrak-border w-full max-w-md mx-4">
            <div className="flex items-center justify-between px-5 py-4 border-b border-ziyrak-border">
              <h3 className="font-semibold text-ziyrak-text">
                {editingCategory ? "Edit Category" : "New Category"}
              </h3>
              <button
                onClick={() => setShowCategoryModal(false)}
                className="p-1 text-ziyrak-text-light hover:text-ziyrak-text rounded transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-ziyrak-text mb-1.5">
                  Name
                </label>
                <input
                  type="text"
                  value={categoryForm.name}
                  onChange={(e) => setCategoryForm({ ...categoryForm, name: e.target.value })}
                  placeholder="e.g. Product FAQ, Returns Policy"
                  className="w-full px-3 py-2 text-sm border border-ziyrak-border rounded-lg focus:outline-none focus:ring-2 focus:ring-ziyrak-primary/30 focus:border-ziyrak-primary"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-ziyrak-text mb-1.5">
                  Description
                </label>
                <input
                  type="text"
                  value={categoryForm.description}
                  onChange={(e) =>
                    setCategoryForm({ ...categoryForm, description: e.target.value })
                  }
                  placeholder="Brief description of this category"
                  className="w-full px-3 py-2 text-sm border border-ziyrak-border rounded-lg focus:outline-none focus:ring-2 focus:ring-ziyrak-primary/30 focus:border-ziyrak-primary"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-ziyrak-text mb-1.5">
                  Color
                </label>
                <div className="flex items-center gap-2 flex-wrap">
                  {colorPresets.map((c) => (
                    <button
                      key={c}
                      onClick={() => setCategoryForm({ ...categoryForm, color: c })}
                      className={cn(
                        "w-7 h-7 rounded-full transition-all",
                        categoryForm.color === c
                          ? "ring-2 ring-offset-2 ring-ziyrak-primary scale-110"
                          : "hover:scale-110"
                      )}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                  <input
                    type="color"
                    value={categoryForm.color}
                    onChange={(e) =>
                      setCategoryForm({ ...categoryForm, color: e.target.value })
                    }
                    className="w-7 h-7 rounded cursor-pointer border border-ziyrak-border"
                    title="Custom color"
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-ziyrak-border">
              <button
                onClick={() => setShowCategoryModal(false)}
                className="px-4 py-2 text-sm font-medium text-ziyrak-text-light hover:text-ziyrak-text rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={saveCategory}
                disabled={!categoryForm.name.trim() || savingCategory}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-ziyrak-primary hover:bg-ziyrak-primary-dark disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
              >
                {savingCategory && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {editingCategory ? "Save Changes" : "Create Category"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= ENTRY MODAL ================= */}
      {showEntryModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setShowEntryModal(false)}
          />
          <div className="relative bg-ziyrak-surface rounded-xl shadow-xl border border-ziyrak-border w-full max-w-lg mx-4">
            <div className="flex items-center justify-between px-5 py-4 border-b border-ziyrak-border">
              <h3 className="font-semibold text-ziyrak-text">
                {editingEntry ? "Edit Entry" : "New Entry"}
              </h3>
              <button
                onClick={() => setShowEntryModal(false)}
                className="p-1 text-ziyrak-text-light hover:text-ziyrak-text rounded transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-ziyrak-text mb-1.5">
                  Title
                </label>
                <input
                  type="text"
                  value={entryForm.title}
                  onChange={(e) => setEntryForm({ ...entryForm, title: e.target.value })}
                  placeholder="e.g. How to reset password"
                  className="w-full px-3 py-2 text-sm border border-ziyrak-border rounded-lg focus:outline-none focus:ring-2 focus:ring-ziyrak-primary/30 focus:border-ziyrak-primary"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-ziyrak-text mb-1.5">
                  Content
                </label>
                <textarea
                  value={entryForm.content}
                  onChange={(e) => setEntryForm({ ...entryForm, content: e.target.value })}
                  placeholder="Write the knowledge content that the AI will use when responding to customers..."
                  rows={8}
                  className="w-full px-3 py-2 text-sm border border-ziyrak-border rounded-lg focus:outline-none focus:ring-2 focus:ring-ziyrak-primary/30 focus:border-ziyrak-primary resize-y"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-ziyrak-text mb-1.5">
                  Priority
                </label>
                <div className="flex items-center gap-2">
                  {PRIORITIES.map((p) => {
                    const Icon = p.icon;
                    return (
                      <button
                        key={p.value}
                        onClick={() => setEntryForm({ ...entryForm, priority: p.value })}
                        className={cn(
                          "inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all",
                          entryForm.priority === p.value
                            ? cn(p.className, "border-current ring-1 ring-current/20")
                            : "border-ziyrak-border text-ziyrak-text-light hover:border-ziyrak-primary/30"
                        )}
                      >
                        <Icon className="h-3 w-3" />
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-ziyrak-border">
              <button
                onClick={() => setShowEntryModal(false)}
                className="px-4 py-2 text-sm font-medium text-ziyrak-text-light hover:text-ziyrak-text rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={saveEntry}
                disabled={!entryForm.title.trim() || savingEntry}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-ziyrak-primary hover:bg-ziyrak-primary-dark disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
              >
                {savingEntry && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {editingEntry ? "Save Changes" : "Create Entry"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= DELETE CONFIRMATION ================= */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setDeleteTarget(null)}
          />
          <div className="relative bg-ziyrak-surface rounded-xl shadow-xl border border-ziyrak-border w-full max-w-sm mx-4">
            <div className="p-5">
              <div className="flex items-center gap-3 mb-3">
                <div className="p-2 rounded-full bg-red-50">
                  <AlertCircle className="h-5 w-5 text-red-600" />
                </div>
                <h3 className="font-semibold text-ziyrak-text">
                  Delete {deleteTarget.type === "category" ? "Category" : "Entry"}
                </h3>
              </div>
              <p className="text-sm text-ziyrak-text-light">
                Are you sure you want to delete{" "}
                <span className="font-medium text-ziyrak-text">{deleteTarget.name}</span>?
                {deleteTarget.type === "category" &&
                  " This will also delete all entries in this category."}
                {" "}This action cannot be undone.
              </p>
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-ziyrak-border">
              <button
                onClick={() => setDeleteTarget(null)}
                className="px-4 py-2 text-sm font-medium text-ziyrak-text-light hover:text-ziyrak-text rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleting}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded-lg transition-colors"
              >
                {deleting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
