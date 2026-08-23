import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { EOL } from "node:os";
import { delimiter } from "node:path";
import { env } from "node:process";

import { ENVIRONMENT } from "#lib/contracts";

interface InputOptions {
	trimWhitespace?: boolean;
}

interface AnnotationProperties {
	file?: string;
	line?: number;
	title?: string;
}

const escapeData = (value: string): string =>
	value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

const escapeProperty = (value: string): string => escapeData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");

const command = (name: string, value: string, properties: Record<string, string> = {}): void => {
	const serialized = Object.entries(properties).map(([key, property]) => `${key}=${escapeProperty(property)}`).join(
		",",
	);
	process.stdout.write(`::${name}${serialized === "" ? "" : ` ${serialized}`}::${escapeData(value)}${EOL}`);
};

const fileCommand = (variable: string, name: string, value: string): boolean => {
	const path = env[variable];
	if (path === undefined || path === "") return false;
	const marker = `dprint_${randomUUID()}`;
	if (value.includes(marker)) throw new Error(`Unable to write ${name}: value contains generated delimiter`);
	appendFileSync(path, `${name}<<${marker}${EOL}${value}${EOL}${marker}${EOL}`, { encoding: "utf8" });
	return true;
};

export const getInput = (name: string, options: InputOptions = {}): string => {
	const value = env[`INPUT_${name.replaceAll(" ", "_").toUpperCase()}`] ?? "";
	return options.trimWhitespace === false ? value : value.trim();
};

export const setSecret = (secret: string): void => command("add-mask", secret);

export const debug = (message: string): void => command("debug", message);

export const info = (message: string): void => void process.stdout.write(`${message}${EOL}`);

export const warning = (message: string): void => command("warning", message);

export const error = (message: string, properties: AnnotationProperties = {}): void => {
	command(
		"error",
		message,
		Object.fromEntries(
			Object.entries(properties)
				.filter((entry): entry is [string, string | number] => entry[1] !== undefined)
				.map(([key, value]) => [key, String(value)]),
		),
	);
};

export const setFailed = (message: string): void => {
	process.exitCode = 1;
	error(message);
};

export const setOutput = (name: string, value: string | boolean): void => {
	const serialized = String(value);
	if (!fileCommand(ENVIRONMENT.githubOutputFile, name, serialized)) command("set-output", serialized, { name });
};

export const saveState = (name: string, value: string): void => {
	if (!fileCommand(ENVIRONMENT.githubStateFile, name, value)) command("save-state", value, { name });
};

export const getState = (name: string): string => env[`STATE_${name}`] ?? "";

export const exportVariable = (name: string, value: string): void => {
	env[name] = value;
	if (!fileCommand(ENVIRONMENT.githubEnvironmentFile, name, value)) command("set-env", value, { name });
};

export const addPath = (path: string): void => {
	env["PATH"] = `${path}${delimiter}${env["PATH"] ?? ""}`;
	const file = env[ENVIRONMENT.githubPathFile];
	if (file !== undefined && file !== "") appendFileSync(file, `${path}${EOL}`, { encoding: "utf8" });
	else command("add-path", path);
};
