import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  date,
  jsonb,
  customType,
} from "drizzle-orm/pg-core";

const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(512)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value
      .replace("[", "")
      .replace("]", "")
      .split(",")
      .map((n) => parseFloat(n));
  },
});

export const citizens = pgTable("citizens", {
  id: uuid("id").primaryKey().defaultRandom(),
  cognitoId: text("cognito_id").unique().notNull(),
  email: text("email").unique().notNull(),
  fullName: text("full_name").notNull().default(""),
  phone: text("phone"),
  avatarUrl: text("avatar_url"),

  dateOfBirth: date("date_of_birth"),
  gender: text("gender"),
  address: text("address"),
  cccdNumber: text("cccd_number").unique(),

  faceEmbedding: vector("face_embedding"),
  emergencyContacts: jsonb("emergency_contacts"),

  isProfileUpdated: boolean("is_profile_updated").notNull().default(false),
  isVerified: boolean("is_verified").notNull().default(false),
  firstDeclareProfile: boolean("first_declare_profile").notNull().default(false),
  consentRegulation: boolean("consent_regulation").notNull().default(false),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const staff = pgTable("staff", {
  id: uuid("id").primaryKey().defaultRandom(),
  cognitoId: text("cognito_id").unique().notNull(),
  email: text("email").unique().notNull(),
  fullName: text("full_name").notNull(),
  phone: text("phone"),
  avatarUrl: text("avatar_url"),

  hospitalName: text("hospital_name").notNull(),
  department: text("department"),
  status: text("status").notNull().default("active"),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const admins = pgTable("admins", {
  id: uuid("id").primaryKey().defaultRandom(),
  cognitoId: text("cognito_id").unique().notNull(),
  email: text("email").unique().notNull(),
  fullName: text("full_name").notNull(),
  avatarUrl: text("avatar_url"),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const medicalRecords = pgTable("medical_records", {
  citizenId: uuid("citizen_id")
    .primaryKey()
    .references(() => citizens.id, { onDelete: "cascade" }),
  distinguishingMarks: text("distinguishing_marks"),
  bloodGroup: text("blood_group"),
  allergies: text("allergies").array(),
  backgroundDiseases: text("background_diseases").array(),
  currentMedications: text("current_medications").array(),
  notes: text("notes"),
  lastUpdated: timestamp("last_updated", { withTimezone: true }).defaultNow(),
});

export const nfcTags = pgTable("nfc_tags", {
  id: text("id").primaryKey(),
  name: text("name"),
  status: text("status").notNull().default("INACTIVE"),
  citizenId: uuid("citizen_id")
    .notNull()
    .references(() => citizens.id, { onDelete: "cascade" }),
  registeredAt: timestamp("registered_at", { withTimezone: true }).defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
});

export const qrCodes = pgTable("qr_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name"),
  status: text("status").notNull().default("INACTIVE"),
  citizenId: uuid("citizen_id")
    .notNull()
    .references(() => citizens.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
});

export const emergencyReports = pgTable("emergency_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  reporterId: uuid("reporter_id").references(() => staff.id),
  victimId: uuid("victim_id").references(() => citizens.id),
  locationLat: text("location_lat").notNull(),
  locationLon: text("location_lon").notNull(),
  situationDescription: text("situation_description"),
  status: text("status").notNull().default("PENDING"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});
