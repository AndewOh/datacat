{{/*
Expand the name of the chart.
*/}}
{{- define "datacat.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
Truncate at 63 chars because some Kubernetes name fields have that limit.
*/}}
{{- define "datacat.fullname" -}}
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
Create chart label value for helm.sh/chart.
*/}}
{{- define "datacat.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels applied to all resources.
*/}}
{{- define "datacat.labels" -}}
helm.sh/chart: {{ include "datacat.chart" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}

{{/*
Selector labels — used in matchLabels and pod template labels.
The caller must pass a dict with "root" (.) and "component" keys via "dict".
Usage: {{ include "datacat.selectorLabels" (dict "root" . "component" "api") }}
*/}}
{{- define "datacat.selectorLabels" -}}
app.kubernetes.io/name: {{ include "datacat.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
Construct a full image reference from global registry + per-service repository + tag.
Usage: {{ include "datacat.image" (dict "root" . "image" .Values.api.image) }}
*/}}
{{- define "datacat.image" -}}
{{- printf "%s/%s:%s" .root.Values.global.image.registry .image.repository .image.tag }}
{{- end }}
