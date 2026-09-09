CREATE TABLE `addon_config` (
	`addon_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`addon_id`, `key`)
);
--> statement-breakpoint
CREATE TABLE `app_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`installed` integer DEFAULT false NOT NULL,
	`oobe_restart_required` integer DEFAULT false NOT NULL,
	`last_version` text,
	`legacy_imported_at` text
);
--> statement-breakpoint
CREATE TABLE `dismissed_updates` (
	`app_id` integer PRIMARY KEY NOT NULL,
	`update_version` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `downloads` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` integer NOT NULL,
	`status` text NOT NULL,
	`updated_at` integer NOT NULL,
	`download_info` text NOT NULL,
	`redistributable_install` text
);
--> statement-breakpoint
CREATE TABLE `failed_setups` (
	`id` text PRIMARY KEY NOT NULL,
	`timestamp` integer NOT NULL,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`download_info` text NOT NULL,
	`setup_data` text NOT NULL,
	`error` text NOT NULL,
	`should` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `image_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`mime_type` text NOT NULL,
	`bytes` blob NOT NULL,
	`cached_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `library` (
	`app_id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`cwd` text NOT NULL,
	`launch_executable` text NOT NULL,
	`launch_arguments` text,
	`launch_env` text,
	`capsule_image` text NOT NULL,
	`cover_image` text NOT NULL,
	`title_image` text,
	`storefront` text NOT NULL,
	`addon_source` text NOT NULL,
	`umu` text,
	`redistributables` text,
	`recent_rank` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `library_recent_rank` ON `library` (`recent_rank`);--> statement-breakpoint
CREATE TABLE `library_removals` (
	`app_id` integer PRIMARY KEY NOT NULL,
	`row` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `required_readds` (
	`app_id` integer PRIMARY KEY NOT NULL,
	`steam_app_id` integer
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`theme` text DEFAULT 'light' NOT NULL,
	`file_download_location` text DEFAULT './downloads' NOT NULL,
	`torrent_client` text DEFAULT 'webtorrent' NOT NULL,
	`parallel_chunk_count` integer DEFAULT 8 NOT NULL,
	`bandwidth_limit` integer DEFAULT 0 NOT NULL,
	`steam_compatibility_tool` text DEFAULT 'proton_experimental' NOT NULL,
	`addons` text DEFAULT '[]' NOT NULL,
	`marketplace_sources` text DEFAULT '["https://ogi-marketplace.nat3z.com"]' NOT NULL,
	`debrid_api_key` text DEFAULT '' NOT NULL,
	`torbox_api_key` text DEFAULT '' NOT NULL,
	`premiumize_api_key` text DEFAULT '' NOT NULL,
	`alldebrid_api_key` text DEFAULT '' NOT NULL,
	`qbit_host` text DEFAULT 'http://127.0.0.1' NOT NULL,
	`qbit_port` text DEFAULT '8080' NOT NULL,
	`qbit_username` text DEFAULT 'admin' NOT NULL,
	`qbit_password` text DEFAULT 'admin' NOT NULL,
	`disable_secret_check` integer DEFAULT false NOT NULL,
	`client_sdk_url` text DEFAULT 'ws://127.0.0.1:7654' NOT NULL,
	`steam_grid_db_api_key` text DEFAULT '' NOT NULL
);
