// Extracted from lib/notifications.ts into its own file so that
// lib/notificationPreferences.ts can import the type constant without
// creating a circular import (notifications.ts -> notificationPreferences.ts
// -> notifications.ts), which under CommonJS resolves to an incomplete
// module and crashes at load time with "Cannot convert undefined or null
// to object" from Object.values(NotificationType) in
// notificationPreferences.ts.
//
// lib/notifications.ts re-exports these two names so nothing importing
// from "./notifications" needs to change.
export const NotificationType = {
  MENTION: "MENTION",
  COMMENT: "COMMENT",
  ASSIGNMENT: "ASSIGNMENT",
  STATUS_CHANGE: "STATUS_CHANGE",
  ORG_EVENT: "ORG_EVENT",
  PR_REVIEW_REQUESTED: "PR_REVIEW_REQUESTED",
  PR_REVIEW_SUBMITTED: "PR_REVIEW_SUBMITTED",
  PR_MERGED: "PR_MERGED",
  DEPLOYMENT_SUCCEEDED: "DEPLOYMENT_SUCCEEDED",
  DEPLOYMENT_FAILED: "DEPLOYMENT_FAILED",
  BUILD_FAILED: "BUILD_FAILED",
  BUILD_FIXED: "BUILD_FIXED",
} as const;

export type NotificationTypeValue =
  (typeof NotificationType)[keyof typeof NotificationType];
