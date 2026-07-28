import { prisma } from "./prisma";
import { NotificationType, NotificationTypeValue } from "./notificationTypes";

// Every notification type gets a row in the response even if the user has
// never touched their preferences — the frontend renders a fixed settings
// grid and shouldn't have to special-case "no row yet" as a third state.
export interface NotificationPreferenceDto {
  type: NotificationTypeValue;
  inApp: boolean;
  email: boolean;
}

const ALL_TYPES = Object.values(NotificationType) as NotificationTypeValue[];

export async function getPreferences(
  userId: string,
): Promise<NotificationPreferenceDto[]> {
  const rows = await prisma.notificationPreference.findMany({
    where: { userId },
  });
  const byType = new Map(rows.map((r) => [r.type, r]));

  return ALL_TYPES.map((type) => {
    const row = byType.get(type);
    return {
      type,
      // Defaults mirror the schema's @default values: in-app on, email off.
      inApp: row?.inApp ?? true,
      email: row?.email ?? false,
    };
  });
}

export async function setPreferences(
  userId: string,
  updates: NotificationPreferenceDto[],
): Promise<NotificationPreferenceDto[]> {
  await Promise.all(
    updates.map((u) =>
      prisma.notificationPreference.upsert({
        where: { userId_type: { userId, type: u.type } },
        create: { userId, type: u.type, inApp: u.inApp, email: u.email },
        update: { inApp: u.inApp, email: u.email },
      }),
    ),
  );
  return getPreferences(userId);
}

// Used by notify()/notifyMany() to decide whether an in-app row should be
// written at all. Defaults to true (matches the DTO default above) so a
// user who has never visited settings still gets every notification.
export async function isInAppEnabled(
  userId: string,
  type: NotificationTypeValue,
): Promise<boolean> {
  const pref = await prisma.notificationPreference.findUnique({
    where: { userId_type: { userId, type } },
    select: { inApp: true },
  });
  return pref?.inApp ?? true;
}
