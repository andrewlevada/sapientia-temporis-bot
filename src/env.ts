export const productionUrl = "https://sapientia-temporis-bot.appspot.com";
export const adminUsername = "andrewlevada";
export const adminUserId = "548598411";

export function isProduction() {
  return process.env.NODE_ENV === "production";
}
