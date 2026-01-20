import { Config } from './config';
import { client } from './client';
import { command as pvcSetup } from './commands/pvc_setup';
import { command as adminStrictness } from './commands/admin_strictness';
import { command as pvcStatus } from './commands/pvc_status';
import { command as pvcCommandChannel } from './commands/pvc_command_channel';
import { command as pvcStaffRole } from './commands/pvc_staff_role';
import { command as pvcCleanup } from './commands/pvc_setup_delete';
import { command as invite } from './commands/invite';
import { command as refreshPvc } from './commands/refresh_pvc';
import { command as deployCommands } from './commands/deploy_commands';
import * as readyEvent from './events/ready';
import * as voiceStateUpdateEvent from './events/voiceStateUpdate';
import * as interactionCreateEvent from './events/interactionCreate';
import * as messageCreateEvent from './events/messageCreate';
import * as guildCreateEvent from './events/guildCreate';
import * as messageReactionAddEvent from './events/messageReactionAdd';
import { startCleanupInterval, stopCleanupInterval } from './utils/stateManager';

client.commands.set(pvcSetup.data.name, pvcSetup);
client.commands.set(adminStrictness.data.name, adminStrictness);
client.commands.set(pvcStatus.data.name, pvcStatus);
client.commands.set(pvcCommandChannel.data.name, pvcCommandChannel);
client.commands.set(pvcStaffRole.data.name, pvcStaffRole);
client.commands.set(pvcCleanup.data.name, pvcCleanup);
client.commands.set(invite.data.name, invite);
client.commands.set(refreshPvc.data.name, refreshPvc);
client.commands.set(deployCommands.data.name, deployCommands);

client.once(readyEvent.name, () => {
    readyEvent.execute(client);
    startCleanupInterval();
});
client.on(voiceStateUpdateEvent.name, (...args) =>
    voiceStateUpdateEvent.execute(client, ...args)
);
client.on(interactionCreateEvent.name, (...args) =>
    interactionCreateEvent.execute(client, ...args)
);
client.on(messageCreateEvent.name, (...args) =>
    messageCreateEvent.execute(client, ...args)
);
client.on(guildCreateEvent.name, (...args) =>
    guildCreateEvent.execute(...args)
);
client.on('messageReactionAdd', (reaction, user) =>
    messageReactionAddEvent.handleMessageReactionAdd(reaction, user)
);

client.on('error', () => { });

client.on('warn', () => { });

process.on('unhandledRejection', () => { });

process.on('uncaughtException', () => { });

client.login(Config.token).catch(() => {
    process.exit(1);
});

process.on('SIGINT', () => {
    stopCleanupInterval();
    client.destroy();
    process.exit(0);
});

process.on('SIGTERM', () => {
    stopCleanupInterval();
    client.destroy();
    process.exit(0);
});
