import { REST, Routes } from 'discord.js';
import { Config } from './config';
import { command as pvcSetup } from './commands/pvc_setup';
import { command as adminStrictness } from './commands/admin_strictness';
import { command as pvcStatus } from './commands/pvc_status';
import { command as pvcCommandChannel } from './commands/pvc_command_channel';
import { command as pvcStaffRole } from './commands/pvc_staff_role';
import { command as strictnessWl } from './commands/strictness_wl';
import { command as pvcCleanup } from './commands/pvc_setup_delete';
import { command as invite } from './commands/invite';

const commands = [
    pvcSetup.data.toJSON(),
    adminStrictness.data.toJSON(),
    pvcStatus.data.toJSON(),
    pvcCommandChannel.data.toJSON(),
    pvcStaffRole.data.toJSON(),
    strictnessWl.data.toJSON(),
    pvcCleanup.data.toJSON(),
    invite.data.toJSON(),
];

const rest = new REST().setToken(Config.token);

async function deployCommands() {
    try {
        // Register commands globally or to a specific guild
        const route = Config.guildId
            ? Routes.applicationGuildCommands(Config.clientId, Config.guildId)
            : Routes.applicationCommands(Config.clientId);

        await rest.put(route, { body: commands });
    } catch {
        process.exit(1);
    }
}

deployCommands();
