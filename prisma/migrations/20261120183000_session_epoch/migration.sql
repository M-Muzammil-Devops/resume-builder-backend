-- Non-destructive: existing users keep epoch 0, so current sessions stay valid until a password change.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "sessionEpoch" INTEGER NOT NULL DEFAULT 0;
