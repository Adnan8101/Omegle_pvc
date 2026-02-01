import gcreate from './create';
import gstart from './start';
import gend from './end';
import greroll from './reroll';
import gcancel from './cancel';
import gdelete from './delete';
import glist from './list';
import ghistory from './history';
import grefresh from './refresh';
import gresume from './resume';
import gstop from './stop';
import gschedule from './schedule';
import refresh_gw from './refresh_gw';
import dummy from './dummy';
export const giveawayCommands: Record<string, any> = {
    gcreate,
    gstart,
    gend,
    greroll,
    gcancel,
    gdelete,
    glist,
    ghistory,
    grefresh,
    gresume,
    gstop,
    gschedule,
    refresh_gw,
    dummy
};
export const prefixCommandMap: Record<string, any> = {
    'gcreate': gcreate,
    'gstart': gstart,
    'gend': gend,
    'greroll': greroll,
    'gcancel': gcancel,
    'gdelete': gdelete,
    'glist': glist,
    'ghistory': ghistory,
    'grefresh': grefresh,
    'gresume': gresume,
    'gstop': gstop,
    'gschedule': gschedule,
    'refresh_gw': refresh_gw,
    'dummy': dummy
};
export default giveawayCommands;
