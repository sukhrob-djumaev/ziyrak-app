"use client";

import { Header } from "@/components/layout/header";
import { cn } from "@/lib/utils";
import {
  Settings as SettingsIcon,
  Bot,
  Mic,
  Phone,
  Mail,
  MessageCircle,
  Save,
  Eye,
  EyeOff,
  CheckCircle,
  AlertCircle,
  Loader2,
} from "lucide-react";
import Link from "next/link";
import { ANTHROPIC_DEFAULT_MODEL, ANTHROPIC_MODELS, getAnthropicModel, isSupportedAnthropicModel } from "@/lib/ai/providers/anthropic-models";
import { useEffect, useState, useCallback } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SettingsData {
  businessName: string;
  businessDesc: string;
  welcomeMessage: string;
  tone: string;
  language: string;
  aiProvider: string;
  aiModel: string;
  aiApiKey: string;
  maxTokens: number;
  temperature: number;
  elevenLabsKey: string;
  elevenLabsVoice: string;
  twilioSid: string;
  twilioToken: string;
  twilioPhone: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapPass: string;
  whatsappMode: string;
  whatsappApiKey: string;
  whatsappPhone: string;
}

type SectionKey =
  | "general"
  | "ai"
  | "voice"
  | "phone"
  | "email"
  | "whatsapp";

interface TabDef {
  key: SectionKey;
  label: string;
  icon: React.ElementType;
}

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------

const tabs: TabDef[] = [
  { key: "general", label: "General", icon: SettingsIcon },
  { key: "ai", label: "AI Configuration", icon: Bot },
  { key: "voice", label: "Voice (ElevenLabs)", icon: Mic },
  { key: "phone", label: "Phone (Twilio)", icon: Phone },
  { key: "email", label: "Email (SMTP/IMAP)", icon: Mail },
  { key: "whatsapp", label: "WhatsApp", icon: MessageCircle },
];

// Which fields belong to each section (used for partial saves)
const sectionFields: Record<SectionKey, (keyof SettingsData)[]> = {
  general: ["businessName", "businessDesc", "welcomeMessage", "tone", "language"],
  ai: ["aiProvider", "aiModel", "aiApiKey", "maxTokens", "temperature"],
  voice: ["elevenLabsKey", "elevenLabsVoice"],
  phone: ["twilioSid", "twilioToken", "twilioPhone"],
  email: [
    "smtpHost",
    "smtpPort",
    "smtpUser",
    "smtpPass",
    "smtpFrom",
    "imapHost",
    "imapPort",
    "imapUser",
    "imapPass",
  ],
  whatsapp: ["whatsappMode", "whatsappApiKey", "whatsappPhone"],
};

// ---------------------------------------------------------------------------
// Toast component
// ---------------------------------------------------------------------------

interface Toast {
  id: number;
  type: "success" | "error";
  message: string;
}

function ToastContainer({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg text-sm font-medium transition-all animate-in slide-in-from-right",
            t.type === "success"
              ? "bg-owly-success text-white"
              : "bg-owly-danger text-white"
          )}
        >
          {t.type === "success" ? (
            <CheckCircle className="h-4 w-4 flex-shrink-0" />
          ) : (
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
          )}
          {t.message}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reusable form components
// ---------------------------------------------------------------------------

function FormField({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-owly-text">
        {label}
      </label>
      {description && (
        <p className="text-xs text-owly-text-light">{description}</p>
      )}
      {children}
    </div>
  );
}

const inputClasses =
  "w-full px-3 py-2 text-sm border border-owly-border rounded-lg bg-owly-bg text-owly-text placeholder:text-owly-text-light/60 focus:outline-none focus:ring-2 focus:ring-owly-primary/30 focus:border-owly-primary transition-colors";

function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={inputClasses}
    />
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <input
      type="number"
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      min={min}
      max={max}
      className={inputClasses}
    />
  );
}

function TextareaInput({
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      className={cn(inputClasses, "resize-none")}
    />
  );
}

function SelectInput({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={inputClasses}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function PasswordInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(inputClasses, "pr-10")}
      />
      <button
        type="button"
        onClick={() => setVisible(!visible)}
        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-owly-text-light hover:text-owly-text rounded transition-colors"
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

function SliderInput({
  value,
  onChange,
  min,
  max,
  step,
  displayValue,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  displayValue?: string;
}) {
  return (
    <div className="flex items-center gap-4">
      <input
        type="range"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        min={min}
        max={max}
        step={step}
        className="flex-1 h-2 rounded-full appearance-none bg-owly-border accent-owly-primary cursor-pointer"
      />
      <span className="text-sm font-medium text-owly-text w-16 text-right">
        {displayValue ?? value}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section save button
// ---------------------------------------------------------------------------

function SaveButton({
  onClick,
  saving,
}: {
  onClick: () => void;
  saving: boolean;
}) {
  return (
    <div className="flex justify-end pt-4 border-t border-owly-border">
      <button
        onClick={onClick}
        disabled={saving}
        className={cn(
          "flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-colors",
          saving
            ? "bg-owly-primary/60 text-white cursor-not-allowed"
            : "bg-owly-primary hover:bg-owly-primary-dark text-white"
        )}
      >
        {saving ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Save className="h-4 w-4" />
        )}
        {saving ? "Saving..." : "Save"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function GeneralSection({
  data,
  update,
}: {
  data: SettingsData;
  update: (field: keyof SettingsData, value: string | number) => void;
}) {
  return (
    <div className="space-y-5">
      <FormField label="Business Name" description="The name of your business or organization.">
        <TextInput
          value={data.businessName}
          onChange={(v) => update("businessName", v)}
          placeholder="My Business"
        />
      </FormField>
      <FormField label="Business Description" description="A short description used for context in AI interactions.">
        <TextareaInput
          value={data.businessDesc}
          onChange={(v) => update("businessDesc", v)}
          placeholder="Describe what your business does..."
        />
      </FormField>
      <FormField label="Welcome Message" description="The greeting message sent to new customers.">
        <TextareaInput
          value={data.welcomeMessage}
          onChange={(v) => update("welcomeMessage", v)}
          placeholder="Hello! How can I help you today?"
        />
      </FormField>
      <FormField label="Tone" description="Choose the communication style for AI responses.">
        <SelectInput
          value={data.tone}
          onChange={(v) => update("tone", v)}
          options={[
            { value: "friendly", label: "Friendly" },
            { value: "professional", label: "Professional" },
            { value: "formal", label: "Formal" },
            { value: "technical", label: "Technical" },
          ]}
        />
      </FormField>
      <FormField label="Language" description="Primary language for AI responses. Auto will detect customer language.">
        <SelectInput
          value={data.language}
          onChange={(v) => update("language", v)}
          options={[
            { value: "auto", label: "Auto-detect" },
            { value: "en", label: "English" },
            { value: "tr", label: "Turkish" },
            { value: "de", label: "German" },
            { value: "fr", label: "French" },
            { value: "es", label: "Spanish" },
            { value: "pt", label: "Portuguese" },
            { value: "ar", label: "Arabic" },
            { value: "zh", label: "Chinese" },
            { value: "ja", label: "Japanese" },
          ]}
        />
      </FormField>
    </div>
  );
}

function AISection({
  data,
  update,
  aiConfigured,
}: {
  data: SettingsData;
  update: (field: keyof SettingsData, value: string | number) => void;
  aiConfigured: boolean;
}) {
  const modelOptions: Record<string, { value: string; label: string }[]> = {
    openai: [
      { value: "gpt-4o", label: "GPT-4o" },
      { value: "gpt-4o-mini", label: "GPT-4o Mini" },
      { value: "gpt-4-turbo", label: "GPT-4 Turbo" },
    ],
    anthropic: ANTHROPIC_MODELS.map((m) => ({ value: m.id, label: m.label })),
    ollama: [
      { value: "llama3", label: "Llama 3" },
      { value: "mistral", label: "Mistral" },
      { value: "codellama", label: "Code Llama" },
    ],
  };

  const knownModels = modelOptions[data.aiProvider] || [];

  return (
    <div className="space-y-5">
      <FormField label="AI Provider" description="Select which AI provider to use for generating responses.">
        <SelectInput
          value={data.aiProvider}
          onChange={(v) => {
            update("aiProvider", v);
            const models = modelOptions[v];
            if (v === "anthropic") {
              update("aiModel", ANTHROPIC_DEFAULT_MODEL);
            } else if (models && models.length > 0) {
              update("aiModel", models[0].value);
            }
            // a key belongs to one provider; never carry a typed one across
            update("aiApiKey", "");
          }}
          options={[
            { value: "openai", label: "OpenAI" },
            { value: "anthropic", label: "Claude (Anthropic)" },
            { value: "ollama", label: "Ollama (Local — coming soon)" },
          ]}
        />
      </FormField>
      <FormField label="Model" description="The specific model to use for AI responses.">
        <SelectInput
          value={data.aiModel}
          onChange={(v) => update("aiModel", v)}
          options={knownModels.some((m) => m.value === data.aiModel) || !data.aiModel
            ? knownModels
            : [
                {
                  value: data.aiModel,
                  label: data.aiProvider === "anthropic" ? `${data.aiModel} (retired — select a supported model)` : data.aiModel,
                },
                ...knownModels,
              ]}
        />
        {data.aiProvider === "anthropic" && data.aiModel && !isSupportedAnthropicModel(data.aiModel) && (
          <p className="mt-1.5 text-xs text-red-600">
            This model is no longer supported. Choose a supported model and save; replies fail until you do.
          </p>
        )}
      </FormField>
      <FormField
        label="API Key"
        description={
          aiConfigured
            ? "A key is stored (encrypted) for this business. The stored key is never shown — enter a new one only to replace it."
            : "Your provider API key. It is stored encrypted and never shown again."
        }
      >
        <PasswordInput
          value={data.aiApiKey}
          onChange={(v) => update("aiApiKey", v)}
          placeholder={
            data.aiProvider === "ollama"
              ? "Not required for local models"
              : aiConfigured
                ? "Key configured — leave blank to keep it"
                : "Enter your API key"
          }
        />
      </FormField>
      <FormField label="Max Tokens" description="Maximum number of tokens per AI response.">
        <SliderInput
          value={data.maxTokens}
          onChange={(v) => update("maxTokens", v)}
          min={256}
          max={8192}
          step={256}
          displayValue={data.maxTokens.toLocaleString()}
        />
      </FormField>
      <FormField
        label="Temperature"
        description={
          data.aiProvider === "anthropic" && getAnthropicModel(data.aiModel)?.sampling === false
            ? "Not used by this Claude model; it manages response variability itself."
            : "Controls randomness. Lower values make responses more focused, higher values more creative."
        }
      >
        <SliderInput
          value={data.temperature}
          onChange={(v) => update("temperature", v)}
          min={0}
          max={2}
          step={0.1}
          displayValue={data.temperature.toFixed(1)}
        />
      </FormField>
    </div>
  );
}

function VoiceSection({
  data,
  update,
}: {
  data: SettingsData;
  update: (field: keyof SettingsData, value: string | number) => void;
}) {
  return (
    <div className="space-y-5">
      <div className="p-4 rounded-lg bg-owly-primary-50/50 border border-owly-primary/20">
        <p className="text-sm text-owly-text">
          Connect your ElevenLabs account to enable AI-powered voice responses for phone calls.
        </p>
      </div>
      <FormField label="API Key" description="Your ElevenLabs API key for text-to-speech.">
        <PasswordInput
          value={data.elevenLabsKey}
          onChange={(v) => update("elevenLabsKey", v)}
          placeholder="Enter your ElevenLabs API key"
        />
      </FormField>
      <FormField label="Voice ID" description="The ElevenLabs voice ID to use for speech synthesis.">
        <TextInput
          value={data.elevenLabsVoice}
          onChange={(v) => update("elevenLabsVoice", v)}
          placeholder="e.g. 21m00Tcm4TlvDq8ikWAM"
        />
      </FormField>
    </div>
  );
}

function PhoneSection({
  data,
  update,
}: {
  data: SettingsData;
  update: (field: keyof SettingsData, value: string | number) => void;
}) {
  return (
    <div className="space-y-5">
      <div className="p-4 rounded-lg bg-owly-primary-50/50 border border-owly-primary/20">
        <p className="text-sm text-owly-text">
          Configure Twilio to enable phone call support. You will need an active Twilio account with a phone number.
        </p>
      </div>
      <FormField label="Account SID" description="Your Twilio Account SID from the dashboard.">
        <PasswordInput
          value={data.twilioSid}
          onChange={(v) => update("twilioSid", v)}
          placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
        />
      </FormField>
      <FormField label="Auth Token" description="Your Twilio authentication token.">
        <PasswordInput
          value={data.twilioToken}
          onChange={(v) => update("twilioToken", v)}
          placeholder="Enter your Twilio auth token"
        />
      </FormField>
      <FormField label="Phone Number" description="Your Twilio phone number in E.164 format.">
        <TextInput
          value={data.twilioPhone}
          onChange={(v) => update("twilioPhone", v)}
          placeholder="+1234567890"
        />
      </FormField>
    </div>
  );
}

function EmailSection({
  data,
  update,
}: {
  data: SettingsData;
  update: (field: keyof SettingsData, value: string | number) => void;
}) {
  return (
    <div className="space-y-6">
      {/* SMTP */}
      <div>
        <h4 className="text-sm font-semibold text-owly-text mb-4 flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-owly-primary" />
          Outgoing Mail (SMTP)
        </h4>
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FormField label="SMTP Host">
              <TextInput
                value={data.smtpHost}
                onChange={(v) => update("smtpHost", v)}
                placeholder="smtp.gmail.com"
              />
            </FormField>
            <FormField label="SMTP Port">
              <NumberInput
                value={data.smtpPort}
                onChange={(v) => update("smtpPort", v)}
                min={1}
                max={65535}
              />
            </FormField>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FormField label="Username">
              <TextInput
                value={data.smtpUser}
                onChange={(v) => update("smtpUser", v)}
                placeholder="your@email.com"
              />
            </FormField>
            <FormField label="Password">
              <PasswordInput
                value={data.smtpPass}
                onChange={(v) => update("smtpPass", v)}
                placeholder="Enter SMTP password"
              />
            </FormField>
          </div>
          <FormField label="From Address" description="The email address that will appear as the sender.">
            <TextInput
              value={data.smtpFrom}
              onChange={(v) => update("smtpFrom", v)}
              placeholder="support@yourbusiness.com"
            />
          </FormField>
        </div>
      </div>

      {/* IMAP */}
      <div>
        <h4 className="text-sm font-semibold text-owly-text mb-4 flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-owly-primary" />
          Incoming Mail (IMAP)
        </h4>
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FormField label="IMAP Host">
              <TextInput
                value={data.imapHost}
                onChange={(v) => update("imapHost", v)}
                placeholder="imap.gmail.com"
              />
            </FormField>
            <FormField label="IMAP Port">
              <NumberInput
                value={data.imapPort}
                onChange={(v) => update("imapPort", v)}
                min={1}
                max={65535}
              />
            </FormField>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FormField label="Username">
              <TextInput
                value={data.imapUser}
                onChange={(v) => update("imapUser", v)}
                placeholder="your@email.com"
              />
            </FormField>
            <FormField label="Password">
              <PasswordInput
                value={data.imapPass}
                onChange={(v) => update("imapPass", v)}
                placeholder="Enter IMAP password"
              />
            </FormField>
          </div>
        </div>
      </div>
    </div>
  );
}

function WhatsAppSection({
  data,
  update,
}: {
  data: SettingsData;
  update: (field: keyof SettingsData, value: string | number) => void;
}) {
  return (
    <div className="space-y-5">
      <div className="p-4 rounded-lg bg-owly-primary-50/50 border border-owly-primary/20">
        <p className="text-sm text-owly-text">
          Choose between WhatsApp Web (free, requires QR scan) or the official WhatsApp Business API (paid, more reliable).
        </p>
      </div>
      <FormField label="Connection Mode" description="Select how Owly connects to WhatsApp.">
        <SelectInput
          value={data.whatsappMode}
          onChange={(v) => update("whatsappMode", v)}
          options={[
            { value: "web", label: "WhatsApp Web" },
            { value: "api", label: "WhatsApp Business API" },
          ]}
        />
      </FormField>
      {data.whatsappMode === "api" && (
        <>
          <FormField label="API Key" description="Your WhatsApp Business API key.">
            <PasswordInput
              value={data.whatsappApiKey}
              onChange={(v) => update("whatsappApiKey", v)}
              placeholder="Enter your WhatsApp API key"
            />
          </FormField>
          <FormField label="Phone Number" description="Your WhatsApp Business phone number in E.164 format.">
            <TextInput
              value={data.whatsappPhone}
              onChange={(v) => update("whatsappPhone", v)}
              placeholder="+1234567890"
            />
          </FormField>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main settings page
// ---------------------------------------------------------------------------

const defaultSettings: SettingsData = {
  businessName: "My Business",
  businessDesc: "",
  welcomeMessage: "Hello! How can I help you today?",
  tone: "friendly",
  language: "auto",
  aiProvider: "openai",
  aiModel: "gpt-4o-mini",
  aiApiKey: "",
  maxTokens: 2048,
  temperature: 0.7,
  elevenLabsKey: "",
  elevenLabsVoice: "",
  twilioSid: "",
  twilioToken: "",
  twilioPhone: "",
  smtpHost: "",
  smtpPort: 587,
  smtpUser: "",
  smtpPass: "",
  smtpFrom: "",
  imapHost: "",
  imapPort: 993,
  imapUser: "",
  imapPass: "",
  whatsappMode: "web",
  whatsappApiKey: "",
  whatsappPhone: "",
};

/** The server's error message when it sent one, else `fallback`. */
async function responseError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    const error = body?.error;
    const message = typeof error === "string" ? error : error?.message;
    return typeof message === "string" && message ? message : fallback;
  } catch {
    return fallback;
  }
}

const PROFILE_FIELDS = ["businessName", "businessDesc", "welcomeMessage", "tone", "language"] as const;
const AI_FIELDS = ["aiProvider", "aiModel", "maxTokens", "temperature"] as const;

export default function SettingsPage() {
  const [data, setData] = useState<SettingsData>(defaultSettings);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<SectionKey>("general");
  const [toasts, setToasts] = useState<Toast[]>([]);
  // General + AI are per-business (BusinessConfig, §46.4). The voice/phone/
  // email/WhatsApp panels edit the legacy single-tenant Settings row, which
  // only the Default Business still has — everyone else configures channel
  // credentials per connection under Channels.
  const [legacyAvailable, setLegacyAvailable] = useState(false);
  const [aiConfigured, setAiConfigured] = useState(false);

  const addToast = useCallback((type: "success" | "error", message: string) => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [profileRes, aiRes] = await Promise.all([
          fetch("/api/settings/business"),
          fetch("/api/settings/ai"),
        ]);
        if (!profileRes.ok) throw new Error(await responseError(profileRes, "Failed to load settings"));
        if (!aiRes.ok) throw new Error(await responseError(aiRes, "Failed to load settings"));

        const profile = await profileRes.json();
        const ai = await aiRes.json();
        const legacyAvailableNow = profile.legacyChannelSettingsAvailable === true;

        const merged: SettingsData = { ...defaultSettings };
        for (const key of [...PROFILE_FIELDS, ...AI_FIELDS] as const) {
          const value = key in profile ? profile[key] : ai[key];
          if (value !== undefined && value !== null) (merged as unknown as Record<string, unknown>)[key] = value;
        }

        if (legacyAvailableNow) {
          const legacyRes = await fetch("/api/settings");
          if (legacyRes.ok) {
            const legacy = await legacyRes.json();
            for (const key of Object.keys(merged) as (keyof SettingsData)[]) {
              const isTenantField = (PROFILE_FIELDS as readonly string[]).includes(key) ||
                (AI_FIELDS as readonly string[]).includes(key) || key === "aiApiKey";
              if (isTenantField) continue;
              if (legacy[key] !== undefined && legacy[key] !== null) {
                (merged as unknown as Record<string, unknown>)[key] = legacy[key];
              }
            }
          }
        }

        if (cancelled) return;
        setData(merged);
        setAiConfigured(ai.aiConfigured === true);
        setLegacyAvailable(legacyAvailableNow);
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "Failed to load settings";
        setLoadError(message);
        addToast("error", message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [addToast]);

  const update = (field: keyof SettingsData, value: string | number) => {
    setData((prev) => ({ ...prev, [field]: value }));
  };

  const saveSection = async () => {
    setSaving(true);
    try {
      const fields = sectionFields[activeTab];
      const payload: Record<string, unknown> = {};
      for (const f of fields) {
        payload[f] = data[f];
      }

      let endpoint = "/api/settings";
      if (activeTab === "general") {
        endpoint = "/api/settings/business";
      } else if (activeTab === "ai") {
        endpoint = "/api/settings/ai";
        // The stored key is never sent back to the browser, so an empty field
        // means "keep the stored key" — only a newly typed one is submitted.
        if (data.aiApiKey && data.aiProvider !== "ollama") {
          payload.aiApiKey = data.aiApiKey;
        } else {
          delete payload.aiApiKey;
        }
      }

      const res = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error(await responseError(res, "Save failed"));

      if (activeTab === "ai") {
        const saved = await res.json();
        setAiConfigured(saved.aiConfigured === true);
        setData((prev) => ({ ...prev, aiApiKey: "" }));
      }
      addToast("success", "Settings saved successfully");
    } catch (error) {
      addToast("error", error instanceof Error && error.message !== "Save failed"
        ? error.message
        : "Failed to save settings. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const visibleTabs = legacyAvailable ? tabs : tabs.filter((t) => t.key === "general" || t.key === "ai");

  const sectionRenderers: Record<SectionKey, React.ReactNode> = {
    general: <GeneralSection data={data} update={update} />,
    ai: <AISection data={data} update={update} aiConfigured={aiConfigured} />,
    voice: <VoiceSection data={data} update={update} />,
    phone: <PhoneSection data={data} update={update} />,
    email: <EmailSection data={data} update={update} />,
    whatsapp: <WhatsAppSection data={data} update={update} />,
  };

  if (loading) {
    return (
      <>
        <Header title="Settings" description="Configure your Owly instance" />
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-owly-primary" />
        </div>
      </>
    );
  }

  if (loadError) {
    return (
      <>
        <Header title="Settings" description="Configure your Owly instance" />
        <div className="flex-1 overflow-auto p-6">
          <div className="max-w-4xl mx-auto bg-owly-surface rounded-xl border border-owly-border p-6 flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-red-500 mt-0.5 shrink-0" />
            <div>
              <h3 className="text-sm font-semibold text-owly-text">Settings could not be loaded</h3>
              <p className="text-sm text-owly-text-light mt-0.5">{loadError}</p>
            </div>
          </div>
        </div>
        <ToastContainer toasts={toasts} />
      </>
    );
  }

  return (
    <>
      <Header title="Settings" description="Configure your Owly instance" />
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-4xl mx-auto">
          {/* Tab navigation */}
          <div className="flex gap-1 p-1 bg-owly-bg rounded-xl border border-owly-border mb-6 overflow-x-auto">
            {visibleTabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={cn(
                    "flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all whitespace-nowrap",
                    isActive
                      ? "bg-owly-surface text-owly-primary shadow-sm"
                      : "text-owly-text-light hover:text-owly-text hover:bg-owly-surface/50"
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {tab.label}
                </button>
              );
            })}
          </div>

          {!legacyAvailable && (
            <p className="text-sm text-owly-text-light mb-4">
              Channel credentials (email, SMS, phone, WhatsApp, Telegram, Web Chat) are configured per channel in{" "}
              <Link href="/channels" className="text-owly-primary hover:underline">
                Channels
              </Link>
              .
            </p>
          )}

          {/* Section content */}
          <div className="bg-owly-surface rounded-xl border border-owly-border p-6 space-y-6">
            <div>
              <h3 className="text-lg font-semibold text-owly-text">
                {tabs.find((t) => t.key === activeTab)?.label}
              </h3>
              <p className="text-sm text-owly-text-light mt-0.5">
                {activeTab === "general" &&
                  "Configure your business identity and communication preferences."}
                {activeTab === "ai" &&
                  "Set up the AI model that powers your customer interactions."}
                {activeTab === "voice" &&
                  "Configure text-to-speech for voice-based support channels."}
                {activeTab === "phone" &&
                  "Connect your Twilio account for phone call handling."}
                {activeTab === "email" &&
                  "Set up email sending and receiving for support tickets."}
                {activeTab === "whatsapp" &&
                  "Configure WhatsApp integration for messaging support."}
              </p>
            </div>

            {sectionRenderers[activeTab]}

            <SaveButton onClick={saveSection} saving={saving} />
          </div>
        </div>
      </div>

      <ToastContainer toasts={toasts} />
    </>
  );
}
