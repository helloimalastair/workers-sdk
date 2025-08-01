import { existsSync } from "fs";
import { cp, mkdtemp, rename } from "fs/promises";
import { tmpdir } from "os";
import { basename, dirname, join, resolve } from "path";
import { shapes, updateStatus, warn } from "@cloudflare/cli";
import { blue, brandColor, dim } from "@cloudflare/cli/colors";
import { spinner } from "@cloudflare/cli/interactive";
import deepmerge from "deepmerge";
import degit from "degit";
import { processArgument } from "helpers/args";
import { C3_DEFAULTS } from "helpers/cli";
import {
	appendFile,
	directoryExists,
	hasTsConfig,
	readFile,
	readJSON,
	writeFile,
	writeJSON,
} from "helpers/files";
import analogTemplate from "templates/analog/c3";
import angularTemplate from "templates/angular/c3";
import astroTemplate from "templates/astro/c3";
import commonTemplate from "templates/common/c3";
import docusaurusTemplate from "templates/docusaurus/c3";
import gatsbyTemplate from "templates/gatsby/c3";
import assetsOnlyTemplate from "templates/hello-world-assets-only/c3";
import helloWorldWithDurableObjectAssetsTemplate from "templates/hello-world-durable-object-with-assets/c3";
import helloWorldDurableObjectTemplate from "templates/hello-world-durable-object/c3";
import helloWorldWithAssetsTemplate from "templates/hello-world-with-assets/c3";
import workflowsTemplate from "templates/hello-world-workflows/c3";
import helloWorldWorkerTemplate from "templates/hello-world/c3";
import honoTemplate from "templates/hono/c3";
import nextTemplate from "templates/next/c3";
import nuxtTemplate from "templates/nuxt/c3";
import openapiTemplate from "templates/openapi/c3";
import preExistingTemplate from "templates/pre-existing/c3";
import queuesTemplate from "templates/queues/c3";
import qwikTemplate from "templates/qwik/c3";
import reactRouterTemplate from "templates/react-router/c3";
import reactTemplate from "templates/react/c3";
import remixTemplate from "templates/remix/c3";
import scheduledTemplate from "templates/scheduled/c3";
import solidTemplate from "templates/solid/c3";
import svelteTemplate from "templates/svelte/c3";
import vueTemplate from "templates/vue/c3";
import { isInsideGitRepo } from "./git";
import { validateProjectDirectory, validateTemplateUrl } from "./validators";
import type { Option } from "@cloudflare/cli/interactive";
import type { C3Args, C3Context, PackageJson } from "types";

export type MultiPlatformTemplateConfig = {
	displayName: string;
	description?: string;
	platformVariants: {
		pages: TemplateConfig;
		workers: TemplateConfig;
	};
	hidden?: boolean;
};

export type TemplateConfig = {
	/**
	 * The version of this configuration schema to use. This will be used
	 * to handle config version skew between different versions of c3
	 */
	configVersion: number;
	/** The id by which template is referred to internally and keyed in lookup maps */
	id: string;
	/** A string that controls how the template is presented to the user in the selection menu */
	displayName: string;
	/** A string that explains what is inside the template, including any resources and how those will be used */
	description?: string;
	/** The deployment platform for this template */
	platform: "workers" | "pages";
	/** The name of the framework cli tool that is used to generate this project or undefined if none */
	frameworkCli?: string;
	/**
	 * A specific version of the framework cli tool to use instead of the standard one taken from the src/frameworks/package.json
	 * (which gets managed and bumped by dependabot)
	 */
	frameworkCliPinnedVersion?: string;
	/** When set to true, hides this template from the selection menu */
	hidden?: boolean;
	/** Specifies a set of files that will be copied to the project directory during creation.
	 *
	 * This can be either a single directory:
	 * ```js
	 * {
	 *    copyFiles: { path: './ts' }
	 * }
	 * ```
	 *
	 * Or an object containing different variants:
	 * ```js
	 * {
	 *    copyFiles: {
	 *      variants: {
	 *        js: { path: "./js"},
	 *        ts: { path: "./ts"},
	 *      }
	 *    }
	 * }
	 * ```
	 * In such case the `js` variant will be used if the project
	 * uses JavaScript and the `ts` variant will be used if the project
	 * uses TypeScript.
	 *
	 * The above mentioned behavior is the default one and can be customized
	 * by providing a `selectVariant` method.
	 *
	 */
	copyFiles?: CopyFiles;

	/** A function invoked as the first step of project creation.
	 * Used to invoke framework creation cli in the internal web framework templates.
	 */
	generate?: (ctx: C3Context) => Promise<void>;
	/** A function invoked after project creation but before deployment.
	 * Used when a template needs to run additional install steps or wrangler commands before
	 * finalizing the project.
	 */
	configure?: (ctx: C3Context) => Promise<void>;

	/**
	 * A transformer that is run on the project's `package.json` during the creation step.
	 *
	 * The object returned from this function will be deep merged with the original.
	 * */
	transformPackageJson?: (
		pkgJson: PackageJson,
		ctx: C3Context,
	) => Promise<Record<string, string | object>>;

	/** An array of compatibility flags to be specified when deploying to pages (unused for workers) */
	compatibilityFlags?: string[];

	/** The key of the package.json "scripts" entry for deploying the project. Defaults to `pages:deploy` */
	deployScript?: string;
	/** The key of the package.json "scripts" entry for developing the project. Defaults to `pages:dev` */
	devScript?: string;
	/** The key of the package.json "scripts" entry for previewing the project. Defaults to undefined (there might not be such script) */
	previewScript?: string;

	/** The path to the generated types file. Defaults to `worker-configuration.d.ts` */
	typesPath?: string;
	/** The name of the Env type generated by wrangler types. Defaults to `Env`*/
	envInterfaceName?: string;

	/** The file path of the template. This is used internally and isn't a user facing config value.*/
	path?: string;

	bindings?: Record<string, unknown>;

	/**
	 * Source for runtime types:
	 * "generated" = types are generated by wrangler types. Default.
	 * "installed" = types are installed from @cloudflare/workers-types.
	 * "none" = no runtime types are provided (e.g. framework for purely static sites).
	 */
	workersTypes?: "generated" | "installed" | "none";
};

type CopyFiles = (StaticFileMap | VariantInfo) & {
	destinationDir?: string | ((ctx: C3Context) => string);
};

// A template can have a number of variants, usually js/ts
type VariantInfo = {
	path: string;
};

type StaticFileMap = {
	selectVariant?: (ctx: C3Context) => Promise<string>;
	variants: Record<string, VariantInfo>;
};

const defaultSelectVariant = async (ctx: C3Context) => {
	return ctx.args.lang;
};

export type TemplateMap = Record<
	string,
	TemplateConfig | MultiPlatformTemplateConfig
>;

export function getFrameworkMap({ experimental = false }): TemplateMap {
	if (experimental) {
		return {
			// None right now
		};
	} else {
		return {
			analog: analogTemplate,
			angular: angularTemplate,
			astro: astroTemplate,
			docusaurus: docusaurusTemplate,
			gatsby: gatsbyTemplate,
			hono: honoTemplate,
			next: nextTemplate,
			nuxt: nuxtTemplate,
			qwik: qwikTemplate,
			react: reactTemplate,
			"react-router": reactRouterTemplate,
			remix: remixTemplate,
			solid: solidTemplate,
			svelte: svelteTemplate,
			vue: vueTemplate,
		};
	}
}

export function getOtherTemplateMap({
	experimental = false,
}): Record<string, TemplateConfig> {
	if (experimental) {
		return {};
	} else {
		return {
			common: commonTemplate,
			scheduled: scheduledTemplate,
			queues: queuesTemplate,
			openapi: openapiTemplate,
			"pre-existing": preExistingTemplate,
		};
	}
}

export function getHelloWorldTemplateMap({
	experimental = false,
}): Record<string, TemplateConfig> {
	if (experimental) {
		return {} as Record<string, TemplateConfig>;
	} else {
		return {
			"hello-world": helloWorldWorkerTemplate,
			"hello-world-assets-only": assetsOnlyTemplate,
			"hello-world-with-assets": helloWorldWithAssetsTemplate,
			"hello-world-durable-object": helloWorldDurableObjectTemplate,
			"hello-world-durable-object-with-assets":
				helloWorldWithDurableObjectAssetsTemplate,
			"hello-world-workflows": workflowsTemplate,
			common: commonTemplate,
			scheduled: scheduledTemplate,
			queues: queuesTemplate,
			openapi: openapiTemplate,
			"pre-existing": preExistingTemplate,
		} as Record<string, TemplateConfig>;
	}
}

export function getNamesAndDescriptions(templateMap: TemplateMap) {
	return Array.from(Object.entries(templateMap)).map(
		([name, { description }]) => ({ name, description }),
	);
}

export const deriveCorrelatedArgs = (args: Partial<C3Args>) => {
	// Derive the type based on the additional arguments provided
	// Both `web-framework` and `remote-template` types are no longer used
	// They are set only for backwards compatibility
	if (args.framework) {
		args.type ??= "web-framework";
	} else if (args.template) {
		args.type ??= "remote-template";
	} else if (args.existingScript) {
		args.type ??= "pre-existing";
	}

	// Derive the category based on the type
	switch (args.type) {
		case "hello-world":
		case "hello-world-durable-object":
		case "hello-world-workflows":
			args.category ??= "hello-world";
			break;
		case "hello-world-python":
			args.category ??= "hello-world";
			// The hello-world-python template is merged into the `hello-world` template
			args.type = "hello-world";
			args.lang = "python";
			break;
		case "webFramework":
			// Add backwards compatibility for the older argument (webFramework)
			warn(
				"The `webFramework` type is deprecated and will be removed in a future version. Please use `web-framework` instead.",
			);
			args.category ??= "web-framework";
			args.type = "web-framework";
			break;
		case "web-framework":
		case "remote-template":
			args.category ??= args.type;
			break;
		case "common":
		case "scheduled":
		case "queues":
		case "openapi":
			args.category ??= "demo";
			break;
		case "pre-existing":
			args.category ??= "others";
			break;
	}

	if (args.ts !== undefined) {
		const language = args.ts ? "ts" : "js";

		if (args.lang !== undefined) {
			throw new Error(
				"The `--ts` argument cannot be specified in conjunction with the `--lang` argument",
			);
		}

		args.lang = language;
	}
};

/**
 * Collecting all information about the template here
 * This includes the project name, the type fo template and the language to use (if applicable)
 * There should be no side effects in these prompts so that we can always go back to the previous step
 */
export const createContext = async (
	args: Partial<C3Args>,
	prevArgs?: Partial<C3Args>,
): Promise<C3Context> => {
	// Derive all correlated arguments first so we can skip some prompts
	deriveCorrelatedArgs(args);

	const experimental = args.experimental;

	const frameworkMap = getFrameworkMap({ experimental });
	const helloWorldTemplateMap = getHelloWorldTemplateMap({
		experimental,
	});
	const otherTemplateMap = getOtherTemplateMap({ experimental });

	let linesPrinted = 0;

	// Allows the users to go back to the previous step
	// By moving the cursor up to a certain line and clearing the screen
	const goBack = async (
		from: "category" | "type" | "framework" | "lang" | "platform",
	) => {
		const currentArgs = { ...args };

		switch (from) {
			case "category":
				args.projectName = undefined;
				break;
			case "type":
				args.category = undefined;
				break;
			case "framework":
				args.category = undefined;
				break;
			case "platform":
				args.framework = undefined;
				break;
			case "lang":
				args.type = undefined;
				args.framework = undefined;
				break;
		}

		// To remove the BACK_VALUE from the result args
		currentArgs[from] = undefined;
		args[from] = undefined;

		if (process.stdout.isTTY) {
			process.stdout.moveCursor(0, -linesPrinted);
			process.stdout.clearScreenDown();
		}

		return await createContext(args, currentArgs);
	};

	// The option to go back to the previous step
	const BACK_VALUE = "__BACK__";
	const backOption: Option = {
		label: "Go back",
		value: BACK_VALUE,
		activeIcon: shapes.backActive,
		inactiveIcon: shapes.backInactive,
	};

	const defaultName = args.existingScript || C3_DEFAULTS.projectName;
	const projectName = await processArgument(args, "projectName", {
		type: "text",
		question: `In which directory do you want to create your application?`,
		helpText: "also used as application name",
		defaultValue: prevArgs?.projectName ?? defaultName,
		label: "dir",
		validate: (value) =>
			validateProjectDirectory(String(value) || C3_DEFAULTS.projectName, args),
		format: (val) => `./${val}`,
	});

	const categoryOptions = [];
	if (Object.keys(helloWorldTemplateMap).length) {
		categoryOptions.push({
			label: "Hello World example",
			value: "hello-world",
			description: "Select from barebones examples to get started with Workers",
		});
	}
	if (Object.keys(frameworkMap).length) {
		categoryOptions.push({
			label: "Framework Starter",
			value: "web-framework",
			description: "Select from the most popular full-stack web frameworks",
		});
	}
	if (Object.keys(otherTemplateMap).length) {
		categoryOptions.push({
			label: "Application Starter",
			value: "demo",
			description:
				"Select from a range of starter applications using various Cloudflare products",
		});
	}
	categoryOptions.push(
		{
			label: "Template from a GitHub repo",
			value: "remote-template",
			description: "Start from an existing GitHub repo link",
		},
		// This is used only if the type is `pre-existing`
		{ label: "Others", value: "others", hidden: true },
		backOption,
	);

	const category = await processArgument(args, "category", {
		type: "select",
		question: "What would you like to start with?",
		label: "category",
		options: categoryOptions,
		defaultValue: prevArgs?.category ?? C3_DEFAULTS.category,
	});
	linesPrinted += 6;

	if (category === BACK_VALUE) {
		return goBack("category");
	}

	let template: TemplateConfig;

	if (category === "web-framework") {
		const frameworkOptions = Object.entries(frameworkMap).reduce<Option[]>(
			(acc, [key, config]) => {
				// only hide if we're going to show the options - otherwise, the
				// result will show up as (skipped) instead of the actual value
				if (!config.hidden || args.framework) {
					acc.push({
						label: config.displayName,
						value: key,
					});
				}
				return acc;
			},
			[],
		);

		const framework = await processArgument(args, "framework", {
			type: "select",
			label: "framework",
			question: "Which development framework do you want to use?",
			options: frameworkOptions.concat(backOption),
			defaultValue: prevArgs?.framework ?? C3_DEFAULTS.framework,
		});
		linesPrinted += 3;

		if (framework === BACK_VALUE) {
			return goBack("framework");
		}

		let frameworkConfig = frameworkMap[framework];

		if (!frameworkConfig) {
			throw new Error(`Unsupported framework: ${framework}`);
		}

		if ("platformVariants" in frameworkConfig) {
			const availableVariants = Object.entries(
				frameworkConfig.platformVariants,
			).filter(([, config]) => !config.hidden) as [
				keyof typeof frameworkConfig.platformVariants,
				TemplateConfig,
			][];

			if (availableVariants.length === 1) {
				args.platform ??= availableVariants[0][0];
			}

			const platform = await processArgument(args, "platform", {
				type: "select",
				label: "platform",
				question: "Select your deployment platform",
				options: [
					...(args.platform === "workers" ||
					!frameworkConfig.platformVariants.workers.hidden
						? [
								{
									label: "Workers with Assets",
									value: "workers",
									description:
										"Take advantage of the full Developer Platform, including R2, Queues, Durable Objects and more.",
								},
							]
						: []),
					...(args.platform === "pages" ||
					!frameworkConfig.platformVariants.pages.hidden
						? [
								{
									label: "Pages",
									value: "pages",
									description: "Great for simple websites and applications.",
								},
							]
						: []),
					backOption,
				],
				defaultValue: "workers",
			});
			linesPrinted += 3;
			if ((platform as string) === BACK_VALUE) {
				return goBack("platform");
			}

			frameworkConfig = frameworkConfig.platformVariants[platform];
		}

		template = {
			deployScript: "pages:deploy",
			devScript: "pages:dev",
			...frameworkConfig,
		};
	} else if (category === "remote-template") {
		template = await processRemoteTemplate(args);
	} else {
		const templateMap =
			category === "hello-world" ? helloWorldTemplateMap : otherTemplateMap;
		const templateOptions: Option[] = Object.entries(templateMap).map(
			([value, { displayName, description, hidden }]) => {
				return {
					value,
					label: displayName,
					description,
					hidden: hidden,
				};
			},
		);

		const type = await processArgument(args, "type", {
			type: "select",
			question: "Which template would you like to use?",
			label: "type",
			options: templateOptions.concat(backOption),
			defaultValue: prevArgs?.type ?? C3_DEFAULTS.type,
		});
		linesPrinted += 3;

		if (type === BACK_VALUE) {
			return goBack("type");
		}

		template = templateMap[type];

		if (!template) {
			throw new Error(`Unknown application type provided: ${type}.`);
		}
	}

	template = {
		workersTypes: "generated",
		typesPath: "./worker-configuration.d.ts",
		envInterfaceName: "Env",
		...template,
	};

	const path = resolve(projectName);
	const languageVariants =
		template.copyFiles &&
		!isVariantInfo(template.copyFiles) &&
		!template.copyFiles.selectVariant
			? Object.keys(template.copyFiles.variants)
			: [];

	// Prompt for language preference only if selectVariant is not defined
	// If it is defined, copyTemplateFiles will handle the selection
	if (languageVariants.length > 0) {
		if (hasTsConfig(path)) {
			// If we can infer from the directory that it uses typescript, use that
			args.lang = "ts";
		} else if (template.generate) {
			// If there is a generate process then we assume that a potential typescript
			// setup must have been part of it, so we should not offer it here
			args.lang = "js";
		} else {
			// Otherwise, prompt the user for their language preference
			const languageOptions = [
				{ label: "TypeScript", value: "ts" },
				{ label: "JavaScript", value: "js" },
				{ label: "Python (beta)", value: "python" },
			];

			const lang = await processArgument(args, "lang", {
				type: "select",
				question: "Which language do you want to use?",
				label: "lang",
				options: languageOptions
					.filter((option) => languageVariants.includes(option.value))
					// Allow going back only if the user is not selecting a remote template
					.concat(args.template ? [] : backOption),
				defaultValue: C3_DEFAULTS.lang,
			});
			linesPrinted += 3;

			if (lang === BACK_VALUE) {
				return goBack("lang");
			}
		}
	}

	const name = basename(path);
	const directory = dirname(path);
	const originalCWD = process.cwd();

	return {
		project: { name, path },
		// We need to maintain a reference to the original args
		// To ensure that we send the latest args to Sparrow
		args: Object.assign(args, { projectName }),
		template,
		originalCWD,
		gitRepoAlreadyExisted: await isInsideGitRepo(directory),
		deployment: {},
	};
};

export async function copyTemplateFiles(ctx: C3Context) {
	if (!ctx.template.copyFiles) {
		return;
	}

	const { copyFiles } = ctx.template;

	let srcdir;
	if (isVariantInfo(copyFiles)) {
		// If there's only one variant, just use that.
		srcdir = join(getTemplatePath(ctx), copyFiles.path);
	} else {
		// Otherwise, have the user select the one they want
		const selectVariant = copyFiles.selectVariant ?? defaultSelectVariant;

		const variant = await selectVariant(ctx);

		const variantInfo = variant ? copyFiles.variants[variant] : null;

		if (!variantInfo) {
			throw new Error(
				`Unknown variant provided: ${JSON.stringify(variant ?? "")}`,
			);
		}

		srcdir = join(getTemplatePath(ctx), variantInfo.path);
	}

	const copyDestDir = getCopyFilesDestinationDir(ctx);
	const destdir = join(ctx.project.path, ...(copyDestDir ? [copyDestDir] : []));

	const s = spinner();
	s.start(`Copying template files`);

	// copy template files
	await cp(srcdir, destdir, { recursive: true, force: true });

	// reverse renaming from build step
	const dummyGitIgnorePath = join(destdir, "__dot__gitignore");
	if (existsSync(dummyGitIgnorePath)) {
		await rename(dummyGitIgnorePath, join(destdir, ".gitignore"));
	}

	s.stop(`${brandColor("files")} ${dim("copied to project directory")}`);
}

export const processRemoteTemplate = async (args: Partial<C3Args>) => {
	const templateUrl = await processArgument(args, "template", {
		type: "text",
		question:
			"What's the url of git repo containing the template you'd like to use?",
		label: "repository",
		validate: (val) => validateTemplateUrl(val || C3_DEFAULTS.template),
		defaultValue: C3_DEFAULTS.template,
	});

	let src = templateUrl;

	// GitHub URL with subdirectory is not supported by degit and has to be transformed.
	// This only addresses input template URLs on the main branch as a branch name
	// might includes slashes that span multiple segments in the URL and cannot be
	// reliably differentiated from the subdirectory path.
	if (src.startsWith("https://github.com/") && src.includes("/tree/main/")) {
		src = src
			.replace("https://github.com/", "github:")
			.replace("/tree/main/", "/");
	}

	const path = await downloadRemoteTemplate(src, args.templateMode);
	const config = inferTemplateConfig(path);

	validateTemplate(path, config);
	updateStatus(`${brandColor("template")} ${dim("cloned and validated")}`);

	return {
		path,
		...config,
	};
};

const validateTemplate = (path: string, config: TemplateConfig) => {
	if (!config.copyFiles) {
		return;
	}

	if (isVariantInfo(config.copyFiles)) {
		validateTemplateSrcDirectory(resolve(path, config.copyFiles.path), config);
	} else {
		for (const variant of Object.values(config.copyFiles.variants)) {
			validateTemplateSrcDirectory(resolve(path, variant.path), config);
		}
	}
};

const validateTemplateSrcDirectory = (path: string, config: TemplateConfig) => {
	if (config.platform === "workers") {
		const wranglerTomlPath = resolve(path, "wrangler.toml");
		const wranglerJsonPath = resolve(path, "wrangler.json");
		const wranglerJsoncPath = resolve(path, "wrangler.jsonc");
		if (
			!existsSync(wranglerTomlPath) &&
			!existsSync(wranglerJsonPath) &&
			!existsSync(wranglerJsoncPath)
		) {
			throw new Error(
				`create-cloudflare templates must contain a "wrangler.toml" or "wrangler.json(c)" file.`,
			);
		}
	}

	const pkgJsonPath = resolve(path, "package.json");
	if (!existsSync(pkgJsonPath)) {
		throw new Error(
			`create-cloudflare templates must contain a "package.json" file.`,
		);
	}
};

/**
 * Remote templates don't require a config file but may in the future. Until then, this
 * function adapts a remote template to work with c3 by inferring a simple config from
 * its file structure.
 */
const inferTemplateConfig = (path: string): TemplateConfig => {
	return {
		configVersion: 1,
		id: "remote-template",
		displayName: "A remote C3 template",
		platform: "workers",
		copyFiles: inferCopyFilesDefinition(path),
	};
};

const inferCopyFilesDefinition = (path: string): CopyFiles => {
	const variants: StaticFileMap["variants"] = {};
	if (existsSync(join(path, "js"))) {
		variants["js"] = { path: "./js" };
	}
	if (existsSync(join(path, "ts"))) {
		variants["ts"] = { path: "./ts" };
	}

	const copyFiles =
		Object.keys(variants).length !== 0 ? { variants } : { path: "." };

	return copyFiles;
};

/**
 * Downloads an external template from a git repo using `degit`.
 *
 * @param src The url of the git repository to download the template from.
 *            For convenience, `owner/repo` is also accepted.
 * @returns A path to a temporary directory containing the downloaded template
 */
export const downloadRemoteTemplate = async (
	src: string,
	mode?: "git" | "tar",
) => {
	// degit runs `git clone` internally which may prompt for credentials if required
	// Avoid using a `spinner()` during this operation -- use updateStatus instead.

	try {
		updateStatus(`Cloning template from: ${blue(src)}`);

		const emitter = degit(src, {
			cache: false,
			verbose: false,
			force: true,
			mode,
		});

		const tmpDir = await mkdtemp(join(tmpdir(), "c3-template"));
		await emitter.clone(tmpDir);

		return tmpDir;
	} catch {
		updateStatus(`${brandColor("template")} ${dim("failed")}`);
		throw new Error(`Failed to clone remote template: ${src}`);
	}
};

export const updatePackageName = async (ctx: C3Context) => {
	// Update package.json with project name
	const placeholderNames = ["<TBD>", "TBD", ""];
	const pkgJsonPath = resolve(ctx.project.path, "package.json");
	const pkgJson = readJSON(pkgJsonPath) as PackageJson;

	if (!placeholderNames.includes(pkgJson.name)) {
		return;
	}

	const s = spinner();
	s.start("Updating name in `package.json`");

	pkgJson.name = ctx.project.name;

	writeJSON(pkgJsonPath, pkgJson);
	s.stop(`${brandColor("updated")} ${dim("`package.json`")}`);
};

export const updatePackageScripts = async (ctx: C3Context) => {
	if (!ctx.template.transformPackageJson) {
		return;
	}

	const s = spinner();
	s.start("Updating `package.json` scripts");

	const pkgJsonPath = resolve(ctx.project.path, "package.json");
	let pkgJson = readJSON(pkgJsonPath) as PackageJson;

	// Run any transformers defined by the template
	const transformed = await ctx.template.transformPackageJson(pkgJson, ctx);
	pkgJson = deepmerge(pkgJson, transformed as PackageJson);

	writeJSON(pkgJsonPath, pkgJson);
	s.stop(`${brandColor("updated")} ${dim("`package.json`")}`);
};

export const getTemplatePath = (ctx: C3Context) => {
	if (ctx.template.path) {
		return resolve(__dirname, "..", ctx.template.path);
	}

	return resolve(__dirname, "..", "templates", ctx.template.id);
};

export const isVariantInfo = (
	copyFiles: CopyFiles,
): copyFiles is VariantInfo => {
	return "path" in (copyFiles as VariantInfo);
};

export const getCopyFilesDestinationDir = (
	ctx: C3Context,
): undefined | string => {
	const { copyFiles } = ctx.template;

	if (!copyFiles?.destinationDir) {
		return undefined;
	}

	if (typeof copyFiles.destinationDir === "string") {
		return copyFiles.destinationDir;
	}

	return copyFiles.destinationDir(ctx);
};

export const addWranglerToGitIgnore = (ctx: C3Context) => {
	const gitIgnorePath = `${ctx.project.path}/.gitignore`;
	const gitIgnorePreExisted = existsSync(gitIgnorePath);

	const gitDirExists = directoryExists(`${ctx.project.path}/.git`);

	if (!gitIgnorePreExisted && !gitDirExists) {
		// if there is no .gitignore file and neither a .git directory
		// then bail as the project is likely not targeting/using git
		return;
	}

	if (!gitIgnorePreExisted) {
		writeFile(gitIgnorePath, "");
	}

	const existingGitIgnoreContent = readFile(gitIgnorePath);
	const wranglerGitIgnoreFilesToAdd: string[] = [];

	const hasDotWrangler = existingGitIgnoreContent.match(
		/^\/?\.wrangler(\/|\s|$)/m,
	);
	if (!hasDotWrangler) {
		wranglerGitIgnoreFilesToAdd.push(".wrangler");
	}

	const hasDotDevDotVars = existingGitIgnoreContent.match(
		/^\/?\.dev\.vars\*(\s|$)/m,
	);
	if (!hasDotDevDotVars) {
		wranglerGitIgnoreFilesToAdd.push(".dev.vars*");
	}

	const hasDotDevVarsExample = existingGitIgnoreContent.match(
		/^!\/?\.dev\.vars\.example(\s|$)/m,
	);
	if (!hasDotDevVarsExample) {
		wranglerGitIgnoreFilesToAdd.push("!.dev.vars.example");
	}

	const hasDotEnv = existingGitIgnoreContent.match(/^\/?\.env\*(\s|$)/m);
	if (!hasDotEnv) {
		wranglerGitIgnoreFilesToAdd.push(".env*");
	}

	const hasDotEnvExample = existingGitIgnoreContent.match(
		/^!\/?\.env\.example(\s|$)/m,
	);
	if (!hasDotEnvExample) {
		wranglerGitIgnoreFilesToAdd.push("!.env.example");
	}

	if (wranglerGitIgnoreFilesToAdd.length === 0) {
		return;
	}

	const s = spinner();
	s.start("Adding Wrangler files to the .gitignore file");

	const linesToAppend = [
		"",
		...(!existingGitIgnoreContent.match(/\n\s*$/) ? [""] : []),
	];

	if (!hasDotWrangler && wranglerGitIgnoreFilesToAdd.length > 1) {
		linesToAppend.push("# wrangler files");
	}

	wranglerGitIgnoreFilesToAdd.forEach((line) => linesToAppend.push(line));

	linesToAppend.push("");

	appendFile(gitIgnorePath, linesToAppend.join("\n"));

	s.stop(
		`${brandColor(gitIgnorePreExisted ? "updated" : "created")} ${dim(
			".gitignore file",
		)}`,
	);
};
