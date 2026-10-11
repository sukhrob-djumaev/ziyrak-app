{{/*
Expand the name of the chart.
*/}}
{{- define "owly.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "owly.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "owly.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "owly.labels" -}}
helm.sh/chart: {{ include "owly.chart" . }}
{{ include "owly.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "owly.selectorLabels" -}}
app.kubernetes.io/name: {{ include "owly.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Service account name
*/}}
{{- define "owly.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "owly.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Database URL - construct from individual fields or use provided URL
*/}}
{{- define "owly.databaseUrl" -}}
{{- if .Values.database.url }}
{{- .Values.database.url }}
{{- else }}
{{- printf "postgresql://%s:%s@%s:%d/%s?schema=public&sslmode=%s" .Values.database.user .Values.database.password .Values.database.host (int .Values.database.port) .Values.database.name .Values.database.sslMode }}
{{- end }}
{{- end }}

{{/*
Secret name - use existing or generate
*/}}
{{- define "owly.secretName" -}}
{{- if .Values.secrets.existingSecret }}
{{- .Values.secrets.existingSecret }}
{{- else }}
{{- include "owly.fullname" . }}
{{- end }}
{{- end }}

{{/*
Direct (non-pooled) database URL — migrations and the job queue.
*/}}
{{- define "owly.directDatabaseUrl" -}}
{{- include "owly.databaseUrl" . }}
{{- end }}

{{/*
Runtime database URL: through PgBouncer when enabled, else direct.
*/}}
{{- define "owly.runtimeDatabaseUrl" -}}
{{- if and .Values.pgbouncer.enabled (not .Values.database.url) }}
{{- printf "postgresql://%s:%s@%s-pgbouncer:5432/%s?schema=public" .Values.database.user .Values.database.password (include "owly.fullname" .) .Values.database.name }}
{{- else }}
{{- include "owly.databaseUrl" . }}
{{- end }}
{{- end }}

{{/*
Redis URL: external if given, else the in-cluster instance, else empty.
*/}}
{{- define "owly.redisUrl" -}}
{{- if .Values.redis.external.url }}
{{- .Values.redis.external.url }}
{{- else if .Values.redis.enabled }}
{{- printf "redis://%s-redis:6379" (include "owly.fullname" .) }}
{{- end }}
{{- end }}

{{/*
PLAN.md §46.8 guard: more than one app replica (or any autoscaling) without
shared state would silently break rate limiting and realtime delivery.
*/}}
{{- define "owly.validate" -}}
{{- $multi := or .Values.autoscaling.enabled .Values.worker.autoscaling.enabled (gt (int .Values.replicaCount) 1) -}}
{{- if and $multi (not (include "owly.redisUrl" .)) -}}
{{- fail "Multiple app replicas or autoscaling need Redis (redis.enabled=true or redis.external.url): without it every replica keeps its own rate-limit window and misses other replicas' realtime events. See PLAN.md §46.8." -}}
{{- end -}}
{{- if and .Values.pgbouncer.enabled .Values.secrets.existingSecret -}}
{{- fail "pgbouncer.enabled cannot be combined with secrets.existingSecret: the in-chart PgBouncer takes the database password from values. Disable it and point DATABASE_URL (in your secret) at your own pooler." -}}
{{- end -}}
{{- if and .Values.pgbouncer.enabled (has .Values.database.sslMode (list "verify-ca" "verify-full")) -}}
{{- fail "database.sslMode verify-ca/verify-full needs a CA file mounted into PgBouncer, which this chart does not provide: use sslMode=require, or run your own pooler (pgbouncer.enabled=false)." -}}
{{- end -}}
{{- if and .Values.pgbouncer.enabled .Values.database.url (not .Values.secrets.existingSecret) -}}
{{- fail "pgbouncer.enabled with database.url: the in-chart PgBouncer is configured from database.host/user/password/name. Set those, point database.url at your own pooler and disable pgbouncer, or supply DATABASE_URL/DIRECT_DATABASE_URL in secrets.existingSecret." -}}
{{- end -}}
{{- end }}
