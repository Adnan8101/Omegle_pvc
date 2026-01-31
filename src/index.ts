import { Config } from './config';
import { client } from './client';
import { command as pvcSetup } from './commands/pvc_setup';
import { command as adminStrictness } from './commands/admin_strictness';
import { command as teamAdminStrictness } from './commands/team_admin_strictness';
import { command as pvcStatus } from './commands/pvc_status';
import { command as pvcCommandChannel } from './commands/pvc_command_channel';
import { command as pvcStaffRole } from './commands/pvc_staff_role';
import { command as pvcCleanup } from './commands/pvc_setup_delete';
import { command as invite } from './commands/invite';
import { command as refreshPvc } from './commands/refresh_pvc';
import { command as deployCommands } from './commands/deploy_commands';
import { command as permanentAccess } from './commands/permanent_access';
import { command as teamSetup } from './commands/team_setup';
import { command as teamStatus } from './commands/team_status';
import { command as teamSetupDelete } from './commands/team_setup_delete';
import { command as teamVcCommandChannel } from './commands/team_vc_command_channel';
import { command as pvcOsTransfer } from './commands/pvc_os_transfer';
import { command as pvcPause } from './commands/pvc_pause';
import { command as pvcResume } from './commands/pvc_resume';
import { command as globalVcBlock } from './commands/global_vc_block';
import { command as wvAllowedRoles } from './commands/wv_allowed_roles';
import { command as showAccess } from './commands/show_access';
import * as readyEvent from './events/ready';
import * as voiceStateUpdateEvent from './events/voiceStateUpdate';
import * as interactionCreateEvent from './events/interactionCreate';
import * as messageCreateEvent from './events/messageCreate';
import * as guildCreateEvent from './events/guildCreate';
import * as messageReactionAddEvent from './events/messageReactionAdd';
import * as channelUpdateEvent from './events/channelUpdate';
import * as channelDeleteEvent from './events/channelDelete';
import { startCleanupInterval, stopCleanupInterval } from './utils/stateManager';
import { vcns } from './vcns';
import { command as funBan } from './commands/fun_ban';
import { command as counting } from './commands/counting';
import { command as ping } from './commands/ping';


// Giveaway Commands
import { giveawayCommands } from './commands/giveaways';

// Giveaway Scheduler Service
import { GiveawaySchedulerService } from './services/GiveawaySchedulerService';
import { giveawayUpdateManager } from './utils/giveaway/GiveawayUpdateManager';
let giveawayScheduler: GiveawaySchedulerService | null = null;

client.commands.set(pvcSetup.data.name, pvcSetup);
client.commands.set(adminStrictness.data.name, adminStrictness);
client.commands.set(teamAdminStrictness.data.name, teamAdminStrictness);
client.commands.set(pvcStatus.data.name, pvcStatus);
client.commands.set('status', pvcStatus);
client.commands.set(pvcCommandChannel.data.name, pvcCommandChannel);
client.commands.set(pvcStaffRole.data.name, pvcStaffRole);
client.commands.set(pvcCleanup.data.name, pvcCleanup);
client.commands.set(invite.data.name, invite);
client.commands.set(refreshPvc.data.name, refreshPvc);
client.commands.set(deployCommands.data.name, deployCommands);
client.commands.set(permanentAccess.data.name, permanentAccess);
client.commands.set(teamSetup.data.name, teamSetup);
client.commands.set(teamStatus.data.name, teamStatus);
client.commands.set(teamSetupDelete.data.name, teamSetupDelete);
client.commands.set(teamVcCommandChannel.data.name, teamVcCommandChannel);
client.commands.set(pvcOsTransfer.data.name, pvcOsTransfer);
client.commands.set(pvcPause.data.name, pvcPause);
client.commands.set(pvcResume.data.name, pvcResume);
client.commands.set(globalVcBlock.data.name, globalVcBlock);
client.commands.set(wvAllowedRoles.data.name, wvAllowedRoles);
client.commands.set(showAccess.data.name, showAccess);
client.commands.set(funBan.data.name, funBan);
client.commands.set(counting.data.name, counting);
client.commands.set(ping.data.name, ping);

// Register Giveaway Commands
for (const [name, command] of Object.entries(giveawayCommands)) {
    if (command.data) {
        client.commands.set(command.data.name, command);
    }
}

client.once(readyEvent.name, async () => {
    await readyEvent.execute(client);
    startCleanupInterval();
    await vcns.start();
    console.log('[VCNS] Virtual Central Nervous System started');
    
    // Start Giveaway Scheduler
    giveawayScheduler = new GiveawaySchedulerService(client);
    giveawayScheduler.start();
    console.log('[Giveaway] Scheduler started');
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
client.on('messageReactionRemove', (reaction, user) =>
    messageReactionAddEvent.handleMessageReactionRemove(reaction, user)
);
client.on(channelUpdateEvent.name, (...args) =>
    channelUpdateEvent.execute(client, ...args)
);
client.on(channelDeleteEvent.name, (...args) =>
    channelDeleteEvent.execute(client, ...args)
);
client.on('error', (error) => {
});
client.on('warn', (warning) => {
    console.warn('[Discord Warning]:', warning);
});
process.on('unhandledRejection', (reason, promise) => {
});
process.on('uncaughtException', (error) => {
});
client.login(Config.token).catch(() => {
    process.exit(1);
});
process.on('SIGINT', async () => {
    console.log('[VCNS] Shutting down...');
    vcns.stop();
    stopCleanupInterval();
    client.destroy();
    process.exit(0);
});
process.on('SIGTERM', async () => {
    console.log('[VCNS] Shutting down...');
    vcns.stop();
    stopCleanupInterval();
    client.destroy();
    process.exit(0);
});
