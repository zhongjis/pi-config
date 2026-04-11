/// <reference path="./clauderock-shims.d.ts" />
import { readFileSync } from "fs";
import { join } from "path";

export function getAwsProfiles(): string[] {
  try {
    const credsPath = join(process.env.HOME || "", ".aws", "credentials");
    const credsFile = readFileSync(credsPath, "utf-8");
    return [...credsFile.matchAll(/^\[(.+)\]$/gm)].map((match) => match[1]);
  } catch {
    return [];
  }
}

export function getPreferredAwsProfile(profiles = getAwsProfiles()): string | undefined {
  const envProfile = process.env.AWS_PROFILE?.trim();
  if (envProfile) return envProfile;
  if (profiles.includes("default")) return undefined;
  if (profiles.length === 1) return profiles[0];
  return profiles[0];
}

export function getAwsProfilesToTry(
  profiles = getAwsProfiles(),
  envProfile = process.env.AWS_PROFILE?.trim(),
): string[] {
  const profilesToTry = ["default", ...profiles.filter((profile) => profile !== "default")];

  if (envProfile && !profilesToTry.includes(envProfile)) {
    profilesToTry.unshift(envProfile);
  }

  return profilesToTry;
}
