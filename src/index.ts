import { BoardRunner, GraphDescriptor, InputResponse, Schema, asRuntimeKit } from "@google-labs/breadboard";
import { Core } from "@google-labs/core-kit";
import { RunConfig, run } from "@google-labs/breadboard/harness";
import * as mermaidCli from "@mermaid-js/mermaid-cli";
import {
	ChatInputCommandInteraction,
	Client,
	Events,
	GatewayIntentBits,
	Guild,
	GuildBasedChannel,
	Interaction,
	Message,
	MessagePayload,
	MessagePayloadOption,
	Partials,
	REST,
	Routes,
	SlashCommandBuilder,
	SlashCommandOptionsOnlyBuilder,
	User,
} from "discord.js";
import "dotenv/config";
import express from 'express';
import fs from "fs";
import os from "os";
import path from "path";
import { InputResolveRequest } from "@google-labs/breadboard/remote";

const app = express();
let botLoggedIn = false;
const port = process.env.PORT || 8080;

type Action = (interaction: any) => Promise<void> | void;

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
if (!DISCORD_CLIENT_ID) {
	throw new Error("Missing DISCORD_CLIENT_ID");
}
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
	throw new Error("Missing DISCORD_TOKEN");
}

const loadBoardCommand = new SlashCommandBuilder()
	.setName("load")
	.setDescription("Loads a board from a url")
	.addStringOption((option) =>
		option
			.setName("url")
			.setDescription("The url of the board")
			.setRequired(true)
	);

	const runBoardCommand = new SlashCommandBuilder()
	.setName("run")
	.setDescription("Runs a board from a URL")
	.addStringOption((option) =>
		option
			.setName("url")
			.setDescription("The url of the board")
			.setRequired(true)
	);

type CustomSlashCommandBuilder = Omit<SlashCommandBuilder, "addSubcommand" | "addSubcommandGroup">

async function setCommands(
	client_id: string,
	token: string,
	commands: SlashCommandOptionsOnlyBuilder[]
) {
	const rest = new REST()
		.setToken(token)
		
		try {
			console.log("Trying to load application slash commands.");
			await rest.put(Routes.applicationCommands(client_id), {
				body: commands.map(command => command.toJSON())
			});
			console.log("Successfully loaded application slash commands.");
		} catch(error) {
			console.error("Failed to load application slash commands.")
		}
	return rest;
}

// await setCommand(DISCORD_CLIENT_ID, DISCORD_TOKEN, loadBoardCommand);
await setCommands(DISCORD_CLIENT_ID, DISCORD_TOKEN, [loadBoardCommand, runBoardCommand]);

const client = new Client({
	intents: [
		GatewayIntentBits.DirectMessages,
		GatewayIntentBits.GuildMembers,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.Guilds,
		GatewayIntentBits.MessageContent,
	],
	partials: [Partials.Channel, Partials.Message],
});

client.on(Events.ClientReady, (client) => {
	botLoggedIn = true;
});

app.get('/healthz', (req, res) => {
	if (botLoggedIn) {
		res.status(200).send('Bot is operational');
	} else {
		res.status(503).send('Bot is not logged in');
	}
});

app.listen(port, () => {
	console.log(`Server started on port ${port}`);
});

client.on(Events.ClientReady, (client) => {
	console.log("Ready");
	client.guilds.cache.forEach((guild: Guild) => {
		console.debug("----");
		guild.channels.cache.forEach((channel: GuildBasedChannel): void => {
			console.debug(guild.name, "-", channel.name);
		});
	});
});

client.on(Events.MessageCreate, async (message): Promise<void> => {
	console.log({ message });
});

function isValidURL(url: string): boolean {
	try {
		new URL(url);
		return true;
	} catch (error) {
		return false;
	}
}
function extractFileNameAndExtension(url: string): {
	name: string;
	extension: string;
} {
	// Extract the last part of the URL (after the last '/')
	const lastSegment = url.split("/").pop();
	if (!lastSegment) {
		return { name: "", extension: "" };
	}

	// Find the last '.' to separate the name and extension
	const lastDotIndex = lastSegment.lastIndexOf(".");

	// If there's no '.', return the whole segment as the name
	if (lastDotIndex === -1) {
		return { name: lastSegment, extension: "" };
	}

	// Extract the name and extension
	const name = lastSegment.substring(0, lastDotIndex);
	const extension = lastSegment.substring(lastDotIndex + 1);

	return { name, extension };
}

client.on(Events.InteractionCreate, async (interaction): Promise<void> => {
	console.log({ interaction });
	const debug = {
		isAnySelectMenu: interaction.isAnySelectMenu(),
		isAutocomplete: interaction.isAutocomplete(),
		isButton: interaction.isButton(),
		isChannelSelectMenu: interaction.isChannelSelectMenu(),
		isChatInputCommand: interaction.isChatInputCommand(),
		isCommand: interaction.isCommand(),
		isContextMenuCommand: interaction.isContextMenuCommand(),
		isMentionableSelectMenu: interaction.isMentionableSelectMenu(),
		isMessageComponent: interaction.isMessageComponent(),
		isMessageContextMenuCommand: interaction.isMessageContextMenuCommand(),
		isModalSubmit: interaction.isModalSubmit(),
		isRepliable: interaction.isRepliable(),
		isRoleSelectMenu: interaction.isRoleSelectMenu(),
		isStringSelectMenu: interaction.isStringSelectMenu(),
		isUserContextMenuCommand: interaction.isUserContextMenuCommand(),
		isUserSelectMenu: interaction.isUserSelectMenu(),
	};
	console.debug({ debug });

	if (interaction.isChatInputCommand()) {
		const command = interaction.commandName;
		const options = interaction.options;
		const user: User = interaction.user;
		const userId = user.id;

		if (command === "load") {
			const url = options.getString("url") || "";
			if (!isValidURL(url)) {
				const message = `Invalid URL: \`${url}\``;
				await respond(interaction, message);
			} else if (!isJsonUrl(url)) {
				const message = `That URL does not end with .json: \`${url}\``;
				await respond(interaction, message);
			} else {
				let json: Object;
				try {
					json = await (await fetch(url)).json();
				} catch (error: any) {
					const message = [
						`I couldn't load that ${url}`,
						toJsonCodeFence(error.message),
					].join("\n");
					await respond(interaction, message);
					return;
				}

				if (!isBGL(json)) {
					const message = `Uh oh, that doesn't look like a board:\n${url}`;
					await respond(interaction, message);
					return;
				}
				const { name, extension } = extractFileNameAndExtension(url);
				const boardMetaDataMarkdown = generateBoardMetadataMarkdown(url, json);

				const loading = await respond(interaction, `Loading ${url}`);
				let message: Message = await respondInChannel(
					interaction,
					[
						`<@${userId}>`,
						boardMetaDataMarkdown,
						"⌛️ `json`",
						"⌛️ `markdown`",
						"⌛️ `mermaid`",
					].join("\n")
				);
				await loading.delete();

				const tempFilename = `${name}.json`;
				const { jsonFile, tempDir } = mkTempFile("breadbot", tempFilename);
				fs.writeFileSync(jsonFile, JSON.stringify(json, bigIntHandler, "\t"));
				message = await editMessage(message, {
					content: [
						`<@${userId}>`,
						boardMetaDataMarkdown,
						"✅ `json` ",
						"⌛️ `markdown`",
						"⌛️ `mermaid`",
					].join("\n"),
					files: [jsonFile],
				});

				const runner = await BoardRunner.fromGraphDescriptor(json);
				const boardMermaid = runner.mermaid();
				const mmdFile = path.join(tempDir, `${name}.mmd`);
				fs.writeFileSync(mmdFile, boardMermaid);

				const markdown = [url, "```mermaid", boardMermaid, "```"].join("\n");
				const markdownFile = path.join(tempDir, `${name}.md`);
				fs.writeFileSync(markdownFile, markdown);
				message = await editMessage(message, {
					content: [
						`<@${userId}>`,
						boardMetaDataMarkdown,
						"✅ `json` ",
						"✅ `markdown`",
						"⌛️ `mermaid`",
					].join("\n"),
					files: [jsonFile, markdownFile],
				});

				type OutputExtension = "md" | "markdown" | "svg" | "png" | "pdf";
				type MermaidOutput = `${string}.${OutputExtension}`;

				const outputFormat: OutputExtension = "png";
				const imageFile: MermaidOutput = path.join(
					tempDir,
					`${name}.${outputFormat}`
				) as MermaidOutput;

				await mermaidCli.run(mmdFile, imageFile, {
					outputFormat
				});

				console.log({ tempFile: imageFile });

				message = await editMessage(message, {
					content: [`<@${userId}>`, boardMetaDataMarkdown].join("\n"),
					files: [jsonFile, markdownFile, imageFile],
				});
			}
		} else if (command === "run") {
			const url = options.getString("url") || "";
			const reply = await interaction.reply({
				content: url,
			}); 
			if (!isValidURL(url)) {
				const message = `Invalid URL: \`${url}\``;
				await respond(interaction, message);
			} else if (!isJsonUrl(url)) {
				const message = `That URL does not end with .json: \`${url}\``;
				await respond(interaction, message);
			} else {
				let json: Object;
				try {
					json = await (await fetch(url)).json();
				} catch (error: any) {
					const message = [
						`I couldn't load that ${url}`,
						toJsonCodeFence(error.message),
					].join("\n");
					await respond(interaction, message);
					return;
				}

				if (!isBGL(json)) {
					const message = `Uh oh, that doesn't look like a board:\n${url}`;
					await respond(interaction, message);
					return;
				}
				const runner = await BoardRunner.fromGraphDescriptor(json);

				const runConfig: RunConfig = {
					url: ".",
					kits: [asRuntimeKit(Core)],
					remote: undefined,
					proxy: undefined,
					diagnostics: true,
					runner: runner,
				};

				const iterator = run(runConfig);

				let result = await iterator.next();
				while (!result.done) {
					if (result.value.type === "input") {
						const inputAttribute = getInputSchemaFromNode(result.value.data);
						const input = await getUserInputForSchema(inputAttribute, interaction);
						await result.value.reply({
							inputs: input
						}  as InputResolveRequest);
					} else if (result.value.type === "output") {
						console.debug(result.value.data.node.id, "output", result.value.data.outputs);
						respondInChannel(interaction, toJsonCodeFence(result.value.data.outputs))
					}
					result = await iterator.next();
				}
			}
		}
	} else {
		await sendDebug(interaction, { debug });
	}
});

client.login(DISCORD_TOKEN);

function mkTempFile(prefix: string, tempFilename: string) {
	const tempDir = mkTempDir(prefix);
	const jsonFile = path.join(tempDir, tempFilename);
	return { jsonFile, tempDir };
}

function mkTempDir(prefix: string) {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function editMessage(
	message: Message<boolean>,
	messageContent: MessagePayloadOption
) {
	const payload: MessagePayload = new MessagePayload(
		message.channel,
		messageContent
	);
	message = await message.edit(payload);
	return message;
}

function generateBoardMetadataMarkdown(url: string, graph: GraphDescriptor) {
	const { name, extension } = extractFileNameAndExtension(url);
	const filename = `${name}.${extension}`;

	const stringBuilder: string[] = [];

	stringBuilder.push(`# [${graph.title || filename}](${graph.url || url})`);

	if (graph.description) {
		stringBuilder.push(`> ${graph.description}`);
	}

	if (graph.$schema) {
		stringBuilder.push(`[$chema](${graph.$schema})`);
	}

	const nodeCount = graph.nodes.length;
	const edgeCount = graph.edges.length;
	const kitCount = graph.kits?.length || 0;
	const graphs: number = graph.graphs
		? Object.keys(graph.graphs).length + 1
		: 1;

	const stats = [
		"```",
		`nodes:  ${nodeCount}`,
		`edges:  ${edgeCount}`,
		`kits:   ${kitCount}`,
		`graphs: ${graphs}`,
		"```",
	].join("\n");
	stringBuilder.push(stats);

	return stringBuilder.join("\n");
}

async function sendDebug(interaction: Interaction, response?: Object) {
	const message = { interaction, ...response };
	const codeFence = toJsonCodeFence(message);
	console.debug({ message });
	await respond(interaction, codeFence);
}

async function respond(interaction: Interaction, message: string) {
	if (interaction.isRepliable()) {
		return await interaction.reply(message);
	} else {
		return await respondInChannel(interaction, message);
	}
}

async function respondInChannel(
	interaction: Interaction,
	message: string,
	options: Omit<MessagePayloadOption, "content"> = {}
): Promise<Message> {
	if (!interaction.channel) {
		throw new Error("No channel to respond in");
	}
	const payload = new MessagePayload(interaction.channel, {
		content: message,
		ephemeral: true,
		...options,
	});
	return await interaction.channel.send(payload);
}

function bigIntHandler(key: any, value: { toString: () => any }) {
	return typeof value === "bigint" ? value.toString() : value;
}

function truncateObject(
	obj: any,
	maxLength: number,
	preserveKeys: string[] = [],
	lessImportantKeys: string[] = [],
	currentDepth: number = 0
): Object {
	let jsonString = JSON.stringify(obj, bigIntHandler, "\t");

	if (jsonString.length <= maxLength) {
		return obj;
	}

	// Function to recursively truncate objects
	function truncateRecursively(
		currentObj: any,
		currentMaxLength: number,
		depth: number
	) {
		const keys = Object.keys(currentObj);
		for (const key of keys) {
			// Skip preserved keys or if length is within limit
			if (preserveKeys.includes(key) || jsonString.length <= currentMaxLength) {
				continue;
			}

			// Handle less important keys differently based on depth
			if (depth > 0 && lessImportantKeys.includes(key)) {
				delete currentObj[key];
				jsonString = JSON.stringify(obj, bigIntHandler, "\t");
				if (jsonString.length <= currentMaxLength) {
					break;
				}
				continue;
			}

			const value = currentObj[key];
			if (typeof value === "string") {
				// Truncate strings
				currentObj[key] = value.substring(
					0,
					value.length - (jsonString.length - currentMaxLength)
				);
			} else if (typeof value === "object" && value !== null) {
				// Recursively handle nested objects
				truncateRecursively(
					value,
					currentMaxLength -
					jsonString.length +
					JSON.stringify(value, bigIntHandler).length,
					depth + 1
				);
			} else {
				// For other types, consider removing or reducing precision
				delete currentObj[key];
			}

			jsonString = JSON.stringify(obj, bigIntHandler, "\t");
			if (jsonString.length <= currentMaxLength) {
				break;
			}
		}
	}

	// Start the truncation process
	truncateRecursively(obj, maxLength, currentDepth);

	return obj;
}

function toJsonCodeFence(obj: any) {
	return [
		"```json",
		JSON.stringify(
			truncateObject(
				obj,
				1000,
				["title", "description", "$schema", "configuration"],
				["description"]
			),
			bigIntHandler,
			"\t"
		),
		"```",
	].join("\n");
}

function isJsonUrl(url: string): boolean {
	return isValidURL(url) && url.endsWith(".json");
}

function isBGL(json: any): json is GraphDescriptor {
	const valid = typeof json == "object" &&
		"nodes" in json &&
		"edges" in json &&
		Array.isArray(json.nodes) == true &&
		Array.isArray(json.edges) == true
	return valid
}

export function getInputSchemaFromNode(inputResponse: InputResponse): Schema {
	return inputResponse.inputArguments.schema as Schema;
}
// Discord can only send a single "reply" per interaction
// So further messages to an interaction are done as a "follow up" 
// setting followUp to true for now, because I want include an initial response to the /run and url being sent, so follow up will be used every time
async function getUserInputForSchema(schema: Schema, interaction: ChatInputCommandInteraction, followUp = true) {

	const askQuestion = async (question: string, interaction: ChatInputCommandInteraction, followUp: boolean, timeout = 30000): Promise<string> => {
		if (!followUp) {
			await interaction.reply(question);
		} else {
			await interaction.followUp(question);
		}

		const filter = (response: Message) => {
			return response.author.id === interaction.user.id && response.channel.id === interaction.channel?.id;;
		};

		try {
			const collected = await interaction.channel?.awaitMessages({ filter, max: 1, time: timeout, errors: ['time'] });
			const reply = collected?.first()?.content ?? 'No reply was received in the time limit.';
			return reply;
		} catch (error) {
			return 'No reply was received in the time limit.';
		}
	}

	async function getInputFromSchema() {
		const userInput: { [key: string]: string } = {};
		for (const key in schema.properties) {
			const property = schema.properties[key];
			if (property.type === "string") {
				const inputAttribute = typeof property.title !== "undefined" ? property.title : key
				const answer = await askQuestion(`Please enter the value for ${inputAttribute}: `, interaction, followUp);
				await interaction.followUp(`Received: ${answer}`)
				userInput[key] = answer;
			}
		}

		return userInput;
	}

	return getInputFromSchema();
}