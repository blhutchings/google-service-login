import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import RequestContext from "./RequestContext";
import { ICookieStore } from "./cookies/ICookieStore";
import MemoryCookieStore from "./cookies/MemoryCookieStore";
import GotoServiceLogin from "./handlers/GotoServiceLogin";
import Identifier from "./handlers/Identifier";
import LoggedIn from "./handlers/LoggedIn";
import Password from "./handlers/Password";
import { ActionHandler } from "./handlers/abstract/AbstractActionHandler";
import AbstractHandler from "./handlers/abstract/AbstractHandler";
import NormalCaptcha, { NormalCaptchaActionHandler } from "./handlers/captcha/NormalCaptcha";
import ReCaptcha, { ReCaptchaActionHandler } from "./handlers/captcha/ReCaptcha";
import ChangePassword from "./handlers/errors/ChangePassword";
import DeniedSignInRejected from "./handlers/errors/DeniedSignInRejected";
import InvalidEndpoint from "./handlers/errors/InvalidEndpoint";
import InvalidRequest from "./handlers/errors/InvalidRequest";
import Rejected from "./handlers/errors/Rejected";
import SessionExpired from "./handlers/errors/SessionExpired";
import UnknownError from "./handlers/errors/UnknownError";
import AdditionalSecurityPrompt from "./handlers/prompts/AdditionalSecurity";
import ChangePasswordNudgePrompt from "./handlers/prompts/ChangePasswordNudgePrompt";
import DefaultVerificationMethodPrompt from "./handlers/prompts/DefaultVerificationMethodPrompt";
import AutoClose from "./handlers/session/AutoClose";
import CookieStoreHandler from "./handlers/session/CookieStoreHandler";
import SelectVerification from "./handlers/verification/SelectVerification";
import TOTPVerification, { TOTPActionHandler } from "./handlers/verification/TOTPVerification";
import SessionPage from "./utils/SessionPage";
import RequestSession from "./RequestSession";
import AutoSignOut from "./handlers/session/AutoSignOut";
import { PuppeteerLaunchOptions } from "puppeteer-core";
import { PuppeteerExtra } from "puppeteer-extra";
import LocalBrowserController from "./browser/LocalBrowserController";
import RemoteBrowserController from "./browser/RemoteBrowserController";
import { LoginRequest } from "./types/LoginRequest";
import { ConnectOptions } from "puppeteer";
import { AbstractBrowserController } from "./browser/AbstractBrowserController";
import { GoogleServiceError } from "./utils/LoginError";


export type GoogleLoginServiceOptions = {
	browserTimeout?: number,
	browserKeepAlive?: boolean,
	cookieStore?: ICookieStore;
	debug?: {
		autoSignOut?: boolean;
		autoClose?: boolean;
	}
} & ({
	browserType?: "local"
	launchOptions?: PuppeteerLaunchOptions,
} | {
	browserType?: "remote"
	launchOptions: ConnectOptions,
})

export default class GoogleServiceLogin {
	private puppeteer: PuppeteerExtra;
	private cookieStore: ICookieStore;
	private browserController: AbstractBrowserController;

	private startHandler: AbstractHandler;

	// Action Handlers
	private recaptcha: ReCaptcha;
	private normalCaptcha: NormalCaptcha;
	private totp: TOTPVerification;

	constructor(options: GoogleLoginServiceOptions) {
		const puppeteerExtra = new PuppeteerExtra(puppeteer);
		const stealth = StealthPlugin();
		stealth.enabledEvasions.delete("iframe.contentWindow");
		stealth.enabledEvasions.delete("navigator.plugins");
		puppeteerExtra.use(stealth);
		this.puppeteer = puppeteerExtra;

		const debugOptions = {
			autoSignOut: options.debug?.autoSignOut ?? false,
			autoClose: options.debug?.autoClose ?? true
		};
		options.browserTimeout = options.browserTimeout ?? 30000;
		options.browserKeepAlive = options.browserKeepAlive ?? false;
		options.cookieStore = options.cookieStore ?? new MemoryCookieStore();
		options.debug = debugOptions;
		options.browserType = options.browserType ?? "local";

		this.cookieStore = options.cookieStore;

		if (options.browserType === "local") {
			this.browserController = new LocalBrowserController(this.puppeteer, options.launchOptions ?? {}, options.browserTimeout, options.browserKeepAlive);
		} else if (options.browserType === "remote") {
			this.browserController = new RemoteBrowserController(this.puppeteer, options.launchOptions, options.browserTimeout, options.browserKeepAlive);
		} else {
			throw new GoogleServiceError("Undefined browsertype", { cause: options.browserType });
		}


		// Global Errors 
		const changePassword = new ChangePassword();
		const deniedSignInRejected = new DeniedSignInRejected();
		const invalidEndpoint = new InvalidEndpoint();
		const invalidRequest = new InvalidRequest();
		const rejected = new Rejected();
		const sessionExpired = new SessionExpired();
		const unknownError = new UnknownError();
		const errors = [changePassword, deniedSignInRejected, invalidEndpoint, invalidRequest, rejected, sessionExpired, unknownError];
		AbstractHandler.addGlobalHandler(errors);

		// Core
		const gotoServiceLogin = new GotoServiceLogin();
		const identifier = new Identifier();
		const password = new Password();
		const loggedIn = new LoggedIn();

		// Captchas
		this.normalCaptcha = new NormalCaptcha();
		this.recaptcha = new ReCaptcha();
		const captchas = [this.normalCaptcha, this.recaptcha];

		// Prompts
		const additionalSecurityPrompt = new AdditionalSecurityPrompt();
		const changePasswordNudge = new ChangePasswordNudgePrompt();
		const defaultVerificationMethodPrompt = new DefaultVerificationMethodPrompt();
		const prompts = [defaultVerificationMethodPrompt, additionalSecurityPrompt, changePasswordNudge];

		// Verification
		const selectVerification = new SelectVerification();
		this.totp = new TOTPVerification();
		const verificationMethods = [this.totp];

		// Session Management
		const cookieLoader = new CookieStoreHandler(this.cookieStore);
		const autoCloseContext = new AutoClose(debugOptions.autoClose);
		const autoSignOut = new AutoSignOut(debugOptions.autoSignOut);


		// ================================================ //
		// 						 Setup						//
		// ================================================ //

		// Entry Points
		this.startHandler = autoCloseContext;
		// Session Management
		autoCloseContext.addHandler(autoSignOut); // Close Context must be first (execute last)
		autoSignOut.addHandler(cookieLoader);
		cookieLoader.addHandler(gotoServiceLogin);


		// Core
		gotoServiceLogin.addHandler(loggedIn, identifier);
		identifier.addHandler(password, captchas);
		password.addHandler(loggedIn, selectVerification, prompts, verificationMethods);

		// Prompts
		additionalSecurityPrompt.addHandler(loggedIn);
		changePasswordNudge.addHandler(loggedIn);
		defaultVerificationMethodPrompt.addHandler(selectVerification);

		// Verification
		selectVerification.addHandler(this.totp);
		this.totp.addHandler(loggedIn, prompts);
	}

	addActionHandler(name: "totp", handler: TOTPActionHandler): void
	addActionHandler(name: "normal-captcha", handler: NormalCaptchaActionHandler): void
	addActionHandler(name: "recaptcha", handler: ReCaptchaActionHandler): void
	addActionHandler(name: string, handler: ActionHandler) {
		switch (name) {
		case "totp":
			this.totp.addActionHandler(handler);
			break;
		case "normal-captcha":
			this.normalCaptcha.addActionHandler(handler);
			break;
		case "recaptcha":
			this.recaptcha.addActionHandler(handler);
			break;
		default:
			throw Error(`No ActionHandler of name '${name}'`);
		}
	}

	async login(request: LoginRequest): Promise<RequestSession> {
		try {
			const context = await this.browserController.createLoginBrowserContext();
			const page = await SessionPage.init(context);
			const cdpSession = await page.target().createCDPSession();
	
			const loginContext = new RequestContext(request, context, page, cdpSession);
			return new RequestSession(this.startHandler, loginContext);
		} catch(err: unknown) {
			if (err instanceof GoogleServiceError) {
				throw err;
			} else if (err instanceof Error) {
				const googleServiceError = new GoogleServiceError(err.message, {cause: err.cause});
				googleServiceError.stack = err.stack;
			}
			throw err;
		}
	}
}