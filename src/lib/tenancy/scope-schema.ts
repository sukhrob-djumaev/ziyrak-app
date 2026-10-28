// Explicit scope projection inventory, generated from the checked-in Prisma schema.
// Update with schema changes; unknown fields/models fail closed.
export const SCOPE_SCHEMA: Record<
  string,
  { relations: Record<string, { model: string; many: boolean }>; scalars: string[] }
> = {
  business: {
    relations: {
      platformAssignments: {
        model: "platformAssignment",
        many: true,
      },
      supportGrants: {
        model: "supportGrant",
        many: true,
      },
      platformAccessAudits: {
        model: "platformAccessAudit",
        many: true,
      },
      memberships: {
        model: "membership",
        many: true,
      },
      config: {
        model: "businessConfig",
        many: false,
      },
      channelConnections: {
        model: "channelConnection",
        many: true,
      },
      apiKeys: {
        model: "apiKey",
        many: true,
      },
      placement: {
        model: "tenantPlacement",
        many: false,
      },
      infrastructurePolicy: {
        model: "infrastructurePolicy",
        many: false,
      },
      categories: {
        model: "category",
        many: true,
      },
      knowledgeEntries: {
        model: "knowledgeEntry",
        many: true,
      },
      departments: {
        model: "department",
        many: true,
      },
      teamMembers: {
        model: "teamMember",
        many: true,
      },
      customers: {
        model: "customer",
        many: true,
      },
      customerNotes: {
        model: "customerNote",
        many: true,
      },
      conversations: {
        model: "conversation",
        many: true,
      },
      messages: {
        model: "message",
        many: true,
      },
      tickets: {
        model: "ticket",
        many: true,
      },
      tags: {
        model: "tag",
        many: true,
      },
      conversationTags: {
        model: "conversationTag",
        many: true,
      },
      internalNotes: {
        model: "internalNote",
        many: true,
      },
      callLogs: {
        model: "callLog",
        many: true,
      },
      schedules: {
        model: "schedule",
        many: true,
      },
      webhooks: {
        model: "webhook",
        many: true,
      },
      webhookDeliveries: {
        model: "webhookDelivery",
        many: true,
      },
      activityLogs: {
        model: "activityLog",
        many: true,
      },
      slaRules: {
        model: "sLARule",
        many: true,
      },
      cannedResponses: {
        model: "cannedResponse",
        many: true,
      },
      automationRules: {
        model: "automationRule",
        many: true,
      },
      campaigns: {
        model: "campaign",
        many: true,
      },
      campaignRuns: {
        model: "campaignRun",
        many: true,
      },
      flows: {
        model: "flow",
        many: true,
      },
      businessHours: {
        model: "businessHours",
        many: true,
      },
      aiInteractionLogs: {
        model: "aIInteractionLog",
        many: true,
      },
      inboundEventReceipts: {
        model: "inboundEventReceipt",
        many: true,
      },
      toolPolicies: {
        model: "toolPolicy",
        many: true,
      },
      actionExecutions: {
        model: "actionExecution",
        many: true,
      },
      deliveryOperations: {
        model: "deliveryOperation",
        many: true,
      },
    },
    scalars: ["id", "slug", "name", "status", "planId", "createdAt", "updatedAt"],
  },
  membership: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
      user: {
        model: "user",
        many: false,
      },
      connectionScopes: {
        model: "membershipConnectionScope",
        many: true,
      },
    },
    scalars: [
      "id",
      "businessId",
      "userId",
      "role",
      "createdAt",
      "scopeMode",
      "customerProfileAccess",
    ],
  },
  user: {
    relations: {
      memberships: {
        model: "membership",
        many: true,
      },
      platformAssignments: {
        model: "platformAssignment",
        many: true,
      },
      supportGrants: {
        model: "supportGrant",
        many: true,
      },
      platformAccessAudits: {
        model: "platformAccessAudit",
        many: true,
      },
      issuedApiKeys: {
        model: "apiKey",
        many: true,
      },
      platformControl: {
        model: "platformControl",
        many: false,
      },
    },
    scalars: [
      "id",
      "username",
      "password",
      "name",
      "isPlatformAdmin",
      "platformRole",
      "createdAt",
      "updatedAt",
    ],
  },
  platformControl: {
    relations: {
      superAdmin: {
        model: "user",
        many: false,
      },
    },
    scalars: ["id", "superAdminUserId", "generation", "updatedAt"],
  },
  membershipConnectionScope: {
    relations: {
      membership: {
        model: "membership",
        many: false,
      },
      connection: {
        model: "channelConnection",
        many: false,
      },
    },
    scalars: ["businessId", "membershipId", "connectionId"],
  },
  apiKeyConnectionScope: {
    relations: {
      apiKey: {
        model: "apiKey",
        many: false,
      },
      connection: {
        model: "channelConnection",
        many: false,
      },
    },
    scalars: ["businessId", "apiKeyId", "connectionId"],
  },
  platformAssignment: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
      operator: {
        model: "user",
        many: false,
      },
      connectionScopes: {
        model: "assignmentConnectionScope",
        many: true,
      },
      supportGrants: {
        model: "supportGrant",
        many: true,
      },
    },
    scalars: [
      "id",
      "businessId",
      "operatorUserId",
      "allowedOperations",
      "scopeMode",
      "customerProfileAccess",
      "reason",
      "expiresAt",
      "revokedAt",
      "createdAt",
      "updatedAt",
    ],
  },
  assignmentConnectionScope: {
    relations: {
      assignment: {
        model: "platformAssignment",
        many: false,
      },
      connection: {
        model: "channelConnection",
        many: false,
      },
    },
    scalars: ["businessId", "operatorUserId", "assignmentId", "connectionId"],
  },
  supportGrant: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
      actor: {
        model: "user",
        many: false,
      },
      assignment: {
        model: "platformAssignment",
        many: false,
      },
      connectionScopes: {
        model: "grantConnectionScope",
        many: true,
      },
      accessAudits: {
        model: "platformAccessAudit",
        many: true,
      },
    },
    scalars: [
      "id",
      "businessId",
      "actorUserId",
      "assignmentId",
      "requestId",
      "allowedOperations",
      "scopeMode",
      "customerProfileAccess",
      "reason",
      "expiresAt",
      "revokedAt",
      "createdAt",
    ],
  },
  grantConnectionScope: {
    relations: {
      grant: {
        model: "supportGrant",
        many: false,
      },
      connection: {
        model: "channelConnection",
        many: false,
      },
    },
    scalars: ["businessId", "grantId", "connectionId"],
  },
  platformAccessAudit: {
    relations: {
      actor: {
        model: "user",
        many: false,
      },
      business: {
        model: "business",
        many: false,
      },
      grant: {
        model: "supportGrant",
        many: false,
      },
    },
    scalars: [
      "id",
      "actorUserId",
      "action",
      "businessId",
      "workspaceId",
      "grantId",
      "reason",
      "details",
      "createdAt",
    ],
  },
  revokedToken: {
    relations: {},
    scalars: ["jti", "userId", "expiresAt", "revokedAt"],
  },
  tenantPlacement: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
    },
    scalars: ["businessId", "databaseProfileId", "storageProfileId", "updatedAt"],
  },
  infrastructurePolicy: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
    },
    scalars: [
      "businessId",
      "dataRegion",
      "permittedAiProviders",
      "permittedEmbeddingProviders",
      "createdAt",
      "updatedAt",
    ],
  },
  workspaceAiAllowance: {
    relations: { business: { model: "business", many: false } },
    scalars: [
      "businessId",
      "mode",
      "status",
      "generationLimitTokens",
      "embeddingLimitTokens",
      "createdAt",
      "updatedAt",
    ],
  },
  aiUsageReservation: {
    relations: { business: { model: "business", many: false } },
    scalars: [
      "id",
      "businessId",
      "kind",
      "periodStart",
      "reservedTokens",
      "settledTokens",
      "state",
      "idempotencyKey",
      "expiresAt",
      "createdAt",
      "updatedAt",
    ],
  },
  aiServicePolicy: {
    relations: {},
    scalars: [
      "id",
      "kind",
      "version",
      "active",
      "displayName",
      "provider",
      "model",
      "credentialRef",
      "maxTokens",
      "temperature",
      "maxPromptTokens",
      "maxToolDepth",
      "createdAt",
    ],
  },
  catalogItem: {
    relations: { versions: { model: "catalogVersion", many: true } },
    scalars: ["id", "key", "kind", "createdAt"],
  },
  catalogVersion: {
    relations: { item: { model: "catalogItem", many: false } },
    scalars: [
      "id",
      "itemId",
      "version",
      "state",
      "name",
      "description",
      "grants",
      "priceMinor",
      "currency",
      "interval",
      "rev",
      "createdBy",
      "publishedBy",
      "publishedAt",
      "archivedAt",
      "createdAt",
      "updatedAt",
    ],
  },
  onboardingState: {
    relations: { business: { model: "business", many: false } },
    scalars: ["businessId", "testReplyStatus", "testReplyAt", "testReplyReason", "activatedAt", "updatedAt"],
  },
  accountToken: {
    relations: {},
    scalars: ["id", "purpose", "tokenHash", "userId", "email", "payload", "expiresAt", "usedAt", "createdAt"],
  },
  databaseProfile: {
    relations: {},
    scalars: ["id", "connectionSecretRef", "region", "createdAt"],
  },
  storageProfile: {
    relations: {},
    scalars: ["id", "credentialSecretRef", "bucket", "region", "createdAt"],
  },
  businessConfig: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
    },
    scalars: [
      "businessId",
      "businessName",
      "businessDesc",
      "welcomeMessage",
      "tone",
      "language",
      "aiProvider",
      "aiModel",
      "embeddingProvider",
      "maxTokens",
      "temperature",
      "aiCredentialRef",
      "embeddingCredentialRef",
      "retentionDays",
      "createdAt",
      "updatedAt",
    ],
  },
  aIInteractionLog: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
      conversation: {
        model: "conversation",
        many: false,
      },
    },
    scalars: [
      "retiredAt",
      "id",
      "businessId",
      "conversationId",
      "kind",
      "provider",
      "model",
      "promptTokens",
      "completionTokens",
      "totalTokens",
      "createdAt",
    ],
  },
  channelConnection: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
      membershipScopes: {
        model: "membershipConnectionScope",
        many: true,
      },
      apiKeyScopes: {
        model: "apiKeyConnectionScope",
        many: true,
      },
      assignmentScopes: {
        model: "assignmentConnectionScope",
        many: true,
      },
      grantScopes: {
        model: "grantConnectionScope",
        many: true,
      },
    },
    scalars: [
      "id",
      "businessId",
      "type",
      "name",
      "isActive",
      "isDefault",
      "status",
      "config",
      "credentialRef",
      "createdAt",
      "updatedAt",
    ],
  },
  inboundEventReceipt: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
      deliveryOperations: {
        model: "deliveryOperation",
        many: true,
      },
    },
    scalars: [
      "retiredAt",
      "id",
      "businessId",
      "source",
      "externalEventId",
      "eventType",
      "receivedAt",
      "processingStatus",
      "correlationId",
      "eventPayload",
    ],
  },
  deliveryOperation: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
      receipt: {
        model: "inboundEventReceipt",
        many: false,
      },
      conversation: {
        model: "conversation",
        many: false,
      },
      action: {
        model: "actionExecution",
        many: false,
      },
      campaignRun: {
        model: "campaignRun",
        many: false,
      },
    },
    scalars: [
      "retiredAt",
      "id",
      "businessId",
      "operationKey",
      "kind",
      "receiptId",
      "conversationId",
      "actionId",
      "campaignRunId",
      "channel",
      "connectionId",
      "recipient",
      "response",
      "metadata",
      "status",
      "retryable",
      "providerMessageId",
      "claimToken",
      "leaseUntil",
      "attempts",
      "errorMessage",
      "recoveryLog",
      "createdAt",
      "updatedAt",
    ],
  },
  settings: {
    relations: {},
    scalars: [
      "id",
      "businessName",
      "businessDesc",
      "welcomeMessage",
      "tone",
      "language",
      "aiProvider",
      "aiModel",
      "aiApiKey",
      "maxTokens",
      "temperature",
      "elevenLabsKey",
      "elevenLabsVoice",
      "twilioSid",
      "twilioToken",
      "twilioPhone",
      "smtpHost",
      "smtpPort",
      "smtpUser",
      "smtpPass",
      "smtpFrom",
      "imapHost",
      "imapPort",
      "imapUser",
      "imapPass",
      "whatsappMode",
      "whatsappApiKey",
      "whatsappPhone",
      "telegramBotToken",
      "createdAt",
      "updatedAt",
    ],
  },
  admin: {
    relations: {},
    scalars: ["id", "username", "password", "name", "role", "createdAt", "updatedAt"],
  },
  category: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
      entries: {
        model: "knowledgeEntry",
        many: true,
      },
    },
    scalars: [
      "id",
      "businessId",
      "name",
      "description",
      "icon",
      "color",
      "sortOrder",
      "createdAt",
      "updatedAt",
    ],
  },
  knowledgeEntry: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
      category: {
        model: "category",
        many: false,
      },
    },
    scalars: [
      "id",
      "businessId",
      "categoryId",
      "title",
      "content",
      "priority",
      "isActive",
      "version",
      "metadata",
      "createdAt",
      "updatedAt",
    ],
  },
  department: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
      members: {
        model: "teamMember",
        many: true,
      },
      tickets: {
        model: "ticket",
        many: true,
      },
    },
    scalars: ["id", "businessId", "name", "description", "email", "createdAt", "updatedAt"],
  },
  teamMember: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
      department: {
        model: "department",
        many: false,
      },
      tickets: {
        model: "ticket",
        many: true,
      },
      schedules: {
        model: "schedule",
        many: true,
      },
    },
    scalars: [
      "id",
      "businessId",
      "name",
      "email",
      "phone",
      "role",
      "expertise",
      "departmentId",
      "isAvailable",
      "createdAt",
      "updatedAt",
    ],
  },
  conversation: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
      customer: {
        model: "customer",
        many: false,
      },
      messages: {
        model: "message",
        many: true,
      },
      deliveryOperations: {
        model: "deliveryOperation",
        many: true,
      },
      tickets: {
        model: "ticket",
        many: true,
      },
      tags: {
        model: "conversationTag",
        many: true,
      },
      notes: {
        model: "internalNote",
        many: true,
      },
      callLogs: {
        model: "callLog",
        many: true,
      },
      aiInteractionLogs: {
        model: "aIInteractionLog",
        many: true,
      },
      actionExecutions: {
        model: "actionExecution",
        many: true,
      },
    },
    scalars: [
      "retiredAt",
      "id",
      "businessId",
      "channel",
      "customerName",
      "customerContact",
      "customerId",
      "status",
      "satisfaction",
      "summary",
      "metadata",
      "createdAt",
      "updatedAt",
    ],
  },
  message: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
      conversation: {
        model: "conversation",
        many: false,
      },
    },
    scalars: [
      "id",
      "businessId",
      "conversationId",
      "role",
      "content",
      "mediaType",
      "mediaUrl",
      "toolCalls",
      "createdAt",
    ],
  },
  ticket: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
      conversation: {
        model: "conversation",
        many: false,
      },
      department: {
        model: "department",
        many: false,
      },
      assignedTo: {
        model: "teamMember",
        many: false,
      },
    },
    scalars: [
      "id",
      "businessId",
      "conversationId",
      "departmentId",
      "assignedToId",
      "title",
      "description",
      "status",
      "priority",
      "resolution",
      "createdAt",
      "updatedAt",
    ],
  },
  tag: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
      conversations: {
        model: "conversationTag",
        many: true,
      },
    },
    scalars: ["id", "businessId", "name", "color", "createdAt"],
  },
  conversationTag: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
      conversation: {
        model: "conversation",
        many: false,
      },
      tag: {
        model: "tag",
        many: false,
      },
    },
    scalars: ["id", "businessId", "conversationId", "tagId"],
  },
  callLog: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
      conversation: {
        model: "conversation",
        many: false,
      },
    },
    scalars: [
      "id",
      "businessId",
      "conversationId",
      "callSid",
      "from",
      "to",
      "duration",
      "status",
      "recording",
      "summary",
      "createdAt",
      "updatedAt",
    ],
  },
  channel: {
    relations: {},
    scalars: ["id", "type", "isActive", "config", "status", "createdAt", "updatedAt"],
  },
  schedule: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
      teamMember: {
        model: "teamMember",
        many: false,
      },
    },
    scalars: ["id", "businessId", "teamMemberId", "dayOfWeek", "startTime", "endTime"],
  },
  webhook: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
      deliveries: {
        model: "webhookDelivery",
        many: true,
      },
    },
    scalars: [
      "id",
      "businessId",
      "name",
      "description",
      "url",
      "method",
      "headers",
      "isActive",
      "triggerOn",
      "createdAt",
      "updatedAt",
    ],
  },
  webhookDelivery: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
      webhook: {
        model: "webhook",
        many: false,
      },
    },
    scalars: [
      "id",
      "businessId",
      "webhookId",
      "event",
      "payload",
      "status",
      "statusCode",
      "attempts",
      "lastError",
      "nextRetryAt",
      "createdAt",
      "updatedAt",
    ],
  },
  activityLog: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
    },
    scalars: [
      "id",
      "businessId",
      "action",
      "entity",
      "entityId",
      "description",
      "userId",
      "userName",
      "metadata",
      "requestId",
      "ipAddress",
      "userAgent",
      "createdAt",
    ],
  },
  sLARule: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
    },
    scalars: [
      "id",
      "businessId",
      "name",
      "description",
      "channel",
      "priority",
      "firstResponseMins",
      "resolutionMins",
      "isActive",
      "createdAt",
      "updatedAt",
    ],
  },
  cannedResponse: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
    },
    scalars: [
      "id",
      "businessId",
      "title",
      "content",
      "category",
      "shortcut",
      "isActive",
      "usageCount",
      "createdAt",
      "updatedAt",
    ],
  },
  customer: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
      notes: {
        model: "customerNote",
        many: true,
      },
      conversations: {
        model: "conversation",
        many: true,
      },
    },
    scalars: [
      "id",
      "businessId",
      "name",
      "email",
      "phone",
      "whatsapp",
      "tags",
      "isBlocked",
      "metadata",
      "firstContact",
      "lastContact",
      "createdAt",
      "updatedAt",
    ],
  },
  customerNote: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
      customer: {
        model: "customer",
        many: false,
      },
    },
    scalars: ["id", "businessId", "customerId", "content", "authorName", "createdAt"],
  },
  automationRule: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
    },
    scalars: [
      "id",
      "businessId",
      "name",
      "description",
      "type",
      "isActive",
      "requiresReconfirmation",
      "conditions",
      "actions",
      "priority",
      "triggerCount",
      "createdAt",
      "updatedAt",
    ],
  },
  businessHours: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
    },
    scalars: [
      "id",
      "businessId",
      "enabled",
      "timezone",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
      "offlineMessage",
    ],
  },
  apiKey: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
      issuedBy: {
        model: "user",
        many: false,
      },
      connectionScopes: {
        model: "apiKeyConnectionScope",
        many: true,
      },
    },
    scalars: [
      "id",
      "businessId",
      "name",
      "keyPrefix",
      "keyHash",
      "role",
      "isActive",
      "lastUsedAt",
      "expiresAt",
      "revokedAt",
      "createdAt",
      "updatedAt",
      "scopeMode",
      "scopeOrigin",
      "customerProfileAccess",
      "issuedByUserId",
    ],
  },
  internalNote: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
      conversation: {
        model: "conversation",
        many: false,
      },
    },
    scalars: ["id", "businessId", "conversationId", "content", "authorName", "createdAt"],
  },
  campaign: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
      runs: {
        model: "campaignRun",
        many: true,
      },
    },
    scalars: [
      "id",
      "businessId",
      "name",
      "description",
      "channel",
      "message",
      "subject",
      "segments",
      "status",
      "scheduledAt",
      "sentCount",
      "createdAt",
      "updatedAt",
    ],
  },
  campaignRun: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
      campaign: {
        model: "campaign",
        many: false,
      },
      deliveryOperations: {
        model: "deliveryOperation",
        many: true,
      },
    },
    scalars: [
      "id",
      "businessId",
      "campaignId",
      "status",
      "authorizationSnapshot",
      "channel",
      "connectionId",
      "message",
      "targetCustomerIds",
      "createdAt",
      "updatedAt",
      "retiredAt",
    ],
  },
  flow: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
    },
    scalars: [
      "id",
      "businessId",
      "name",
      "description",
      "startNodeId",
      "nodes",
      "isActive",
      "triggerCount",
      "createdAt",
      "updatedAt",
    ],
  },
  toolPolicy: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
    },
    scalars: [
      "id",
      "businessId",
      "tool",
      "enabledForTenant",
      "allowedForAI",
      "allowedForHumanRoles",
      "requiresHumanApproval",
      "createdAt",
      "updatedAt",
    ],
  },
  actionExecution: {
    relations: {
      business: {
        model: "business",
        many: false,
      },
      conversation: {
        model: "conversation",
        many: false,
      },
      deliveryOperations: {
        model: "deliveryOperation",
        many: true,
      },
    },
    scalars: [
      "retiredAt",
      "id",
      "businessId",
      "tool",
      "status",
      "input",
      "result",
      "conversationId",
      "legacyConversationId",
      "authorizationSnapshot",
      "requestedBy",
      "idempotencyKey",
      "errorMessage",
      "createdAt",
      "updatedAt",
      "completedAt",
    ],
  },
};
