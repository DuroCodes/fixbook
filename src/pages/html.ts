import { readFileSync } from "node:fs";

const read = (name: string) =>
  readFileSync(new URL(`./${name}.html`, import.meta.url), "utf8");

const fill = (template: string, values: Record<string, string>) =>
  Object.entries(values).reduce(
    (html, [key, value]) => html.replaceAll(`{{${key}}}`, value),
    template,
  );

export const homeHtml = () => read("home");

export const embedHtml = (values: Record<string, string>) =>
  fill(read("embed"), values);
