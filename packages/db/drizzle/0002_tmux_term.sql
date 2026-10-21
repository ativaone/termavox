ALTER TABLE `servers` ADD `tmux_term` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `tmux_term` text DEFAULT 'auto' NOT NULL;