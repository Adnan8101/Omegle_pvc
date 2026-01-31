import { REST, Routes } from 'discord.js';
import { Config } from './config';
import { command as pvcSetup } from './commands/pvc_setup';
import { command as adminStrictness } from './commands/admin_strictness';
import { command as teamAdminStrictness } from './commands/team_admin_strictness';
import { command as pvcStatus } from './commands/pvc_status';
import { command as pvcCommandChannel } from './commands/pvc_command_channel';
import { command as pvcStaffRole } from './commands/pvc_staff_role';
import { command as pvcCleanup } from './commands/pvc_setup_delete';
import { command as invite } from './commands/invite';
import { command as refreshPvc } from './commands/refresh_pvc';
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
import { command as deployCommandsCmd } from './commands/deploy_commands';
import { command as funBan } from './commands/fun_ban';
import { command as counting } from './commands/counting';
import { command as ping } from './commands/ping';
import prisma from './utils/database';

// Giveaway commands
import { giveawayCommands } from './commands/giveaways';

// Base commands array
const baseCommands = [
    pvcSetup.data.toJSON(),
    adminStrictness.data.toJSON(),
    teamAdminStrictness.data.toJSON(),
    pvcStatus.data.toJSON(),
    pvcCommandChannel.data.toJSON(),
    pvcStaffRole.data.toJSON(),
    pvcCleanup.data.toJSON(),
    invite.data.toJSON(),
    refreshPvc.data.toJSON(),
    permanentAccess.data.toJSON(),
    teamSetup.data.toJSON(),
    teamStatus.data.toJSON(),
    teamSetupDelete.data.toJSON(),
    teamVcCommandChannel.data.toJSON(),
    pvcOsTransfer.data.toJSON(),
    pvcPause.data.toJSON(),
    pvcResume.data.toJSON(),
    globalVcBlock.data.toJSON(),
    wvAllowedRoles.data.toJSON(),
    showAccess.data.toJSON(),
    deployCommandsCmd.data.toJSON(),
    funBan.data.toJSON(),
    counting.data.toJSON(),
    ping.data.toJSON(),
];

// Add giveaway commands to the array
const giveawayCommandsArray = Object.values(giveawayCommands)
    .filter((cmd: any) => cmd.data)
    .map((cmd: any) => cmd.data.toJSON());

const commands = [...baseCommands, ...giveawayCommandsArray];
const rest = new REST().setToken(Config.token);
async function deployCommands() {
    try {
        console.log(`Started refreshing ${commands.length} application (/) commands.`);
        console.log(`Base commands: ${baseCommands.length}`);
        console.log(`Giveaway commands: ${giveawayCommandsArray.length}`);
        
        const route = Config.guildId
            ? Routes.applicationGuildCommands(Config.clientId, Config.guildId)
            : Routes.applicationCommands(Config.clientId);
        await rest.put(route, { body: commands });
        
        console.log(`Successfully reloaded ${commands.length} application (/) commands.`);
        await prisma.$disconnect();
        process.exit(0);
    } catch (error) {
        console.error('Failed to deploy commands:', error);
        await prisma.$disconnect();
        process.exit(1);
    }
}
deployCommands();
